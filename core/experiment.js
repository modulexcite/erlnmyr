/*
  Copyright 2015 Google Inc. All Rights Reserved.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

var dot = require('graphlib-dot');
var types = require('./types');
var graph = require('./graph');
var linearize = require('./linearize');
var stream = require('./stream');
var phase = require('./phase');
var stageLoader = require('./stage-loader');
var assert = require('chai').assert;
var Promise = require('bluebird');
var definePhase = require('./register').phase;
var register = require('./register');
var path = require('path');
var commandLineOptions = require('./options');

function getPhaseName(nodeName, options) {
  var phaseName = nodeName;
  var splits = phaseName.split('_');
  if (options.stage) {
      phaseName = options.stage;
  } else if (options.label) {
      phaseName = options.label;
  } else if (splits.length > 1) {
      phaseName = splits[0];
  }
  return phaseName;
}

function getNodeID(nodeName) {
  var i = nodeName.indexOf('_');
  if (i === -1)
    return null;
  return nodeName.slice(i + 1);
}

function parseOptionAliases(optionAliases) {
  var aliases = [];
  if (typeof optionAliases !== 'string' || optionAliases === '')
    return aliases;
  var regex = /(\w+)=(\w+)\.(\w+)/g;
  var match = null;
  while (match = regex.exec(optionAliases)) {
    aliases.push({
      alias: match[1],
      selector: match[2],
      option: match[3],
    });
  }
  return aliases;
}

function addCommandLineOptions(phaseName, nodeID, optionAliases, resultOptions) {
  function addIfKeyPresent(key, options) {
    if (key in commandLineOptions && typeof commandLineOptions[key] === 'object') {
      for (var innerKey in commandLineOptions[key])
        resultOptions[innerKey] = commandLineOptions[key][innerKey];
    }
  }
  addIfKeyPresent(phaseName, commandLineOptions);
  addIfKeyPresent(nodeID, commandLineOptions);
  // TODO: Just parse optionAliases once per experiment.
  parseOptionAliases(optionAliases).forEach(function(optionAlias) {
    if (optionAlias.alias in commandLineOptions && (optionAlias.selector === phaseName || optionAlias.selector === nodeID))
      resultOptions[optionAlias.option] = commandLineOptions[optionAlias.alias];
  })
}

function mkPhase(nodeName, inGraph) {
  var options = inGraph.node(nodeName) || {};
  var phaseName = getPhaseName(nodeName, options);
  var nodeID = getNodeID(nodeName);
  options.id = nodeID;
  addCommandLineOptions(phaseName, nodeID, inGraph.graph().optionAliases, options);
  var result = new graph.Pipe(phaseName, options);
  result.nodeName = nodeName;
  return result;
}

var traceExperiment = undefined;

function linearConnectEdges(inGraph) {
  var nodes = inGraph.nodes();
  traceExperiment && traceExperiment("experiment nodes are", nodes, "\nAttempting graph construction");
  var handledNodes = {};
  var handledNodeCount = 0;

  while (handledNodeCount < nodes.length) {
    for (var i = 0; i < nodes.length; i++) {
      if (handledNodes[nodes[i]] !== undefined)
        continue;
      
      traceExperiment && traceExperiment("+ assessing", nodes[i]);

      var outEdges = inGraph.outEdges(nodes[i]);
      
      traceExperiment && traceExperiment("  - outEdges: ", outEdges);

      var validNode = true;
      for (var j = 0; j < outEdges.length; j++) {
        if (handledNodes[outEdges[j].w] == undefined) {
          traceExperiment && traceExperiment("  - target", outEdges[j].w, "not yet placed");
          validNode = false;
          break;
        }
      }
      if (validNode) {
        var from = mkPhase(nodes[i], inGraph);
        handledNodes[nodes[i]] = from;
        handledNodeCount++;
        var tos = [];
        for (var j = 0; j < outEdges.length; j++) {
          var to = handledNodes[outEdges[j].w];
          if (to.in == undefined)
            graph.connect(from, to);
          else
            tos.push(to)
        }
        tos.forEach(function(to) {
          graph.connect(from, to);
        });
      }
    }
  }

  var graphs = [];
  for (var i = 0; i < nodes.length; i++) {
    var g = handledNodes[nodes[i]].graph;
    if (graphs.indexOf(g) == -1)
      graphs.push(g);
  }

  var result = graphs.map(linearize).reduce(function(a, b) { return a.concat(b); });
  traceExperiment && traceExperiment("linearized result:",
      result.map(function(list) { return list.map(function(phase) { return phase.nodeName; })}));
  return result;
}

var bundled = {
  'trace-phases': path.join(__dirname, '../lib/trace-phases'),
  'chromium-phases': path.join(__dirname, '../lib/chromium-phases/chromium-phases'),
  'device-phases': path.join(__dirname, '../lib/device-phases'),
  'browser-phases': path.join(__dirname, '../lib/browser-phases'),
  'test-phases': path.join(__dirname, '../lib/test-phases')
};

function buildstageList(graphData, tags, require) {
  var inGraph = dot.read(graphData);
  // TODO: Perhaps create instance of stage-loader and ask it to load these
  //       to avoid polluting other experiments.
  if (inGraph.graph().imports) {
    var imports = eval(inGraph.graph().imports);
    imports.forEach(function(lib) {
      // TODO: Are we passing the wrong tags object?
      if (bundled[lib]) {
        lib = bundled[lib];
      } else if (tags.tags.filename && lib[0] == '.') {
        lib = path.join(path.dirname(tags.tags.filename), lib);
      }
      register.load(require(lib));
    });
  }
  var linear = linearConnectEdges(inGraph);
  var linearNames = linear.map(function(x) { return x.map(function(a) { return a.nodeName; })});

  // Find the {strategy:pipeline} groups that each phase participates in.
  var linearGroups = linearNames.map(function(a) { return a.map(function(x) {
    var result = [];
    var parent = inGraph.parent(x);
    while (parent !== undefined) {
      if (inGraph.node(parent).strategy == 'pipeline')
        result.push(parent);
      parent = inGraph.parent(parent);
    }
    return result;
  }); });

  // For each set of phases at the same linear level, find the groups
  // that every element of the set is part of.
  linearGroups = linearGroups.map(function(x) {
    var result = [];
    for (var i = 0; i < x[0].length; i++) {
      for (var j = 1; j < x.length; j++) {
        if (x[j].indexOf(x[0][i]) == -1)
          break;
      }
      if (j == x.length)
        result.push(x[0][i]);
    }
    return result;
  });

  // Phases being constructed, contains sublists for pipeline phases.
  var phaseStack = [[]];
  // Names of the current groups.
  var groupStack = [];

  for (var i = 0; i < linear.length; i++) {
     for (var j = 0; j < linearGroups[i].length; j++) {
      if (groupStack.indexOf(linearGroups[i][j]) == -1) {
        // Enter a new group and start a new phase list.
        groupStack.push(linearGroups[i][j]);
        phaseStack.push([]);
      }
    }

    var streams = [];
    linear[i].forEach(function(pipe, idx) {
      if (pipe.stageName == undefined)
        pipe.stageName = 'passthrough';
      var thisStream = stageLoader.stageSpecificationToStage({name: pipe.stageName, options: pipe.options});
      if (thisStream instanceof Array) {
        thisStream[0].setInput('efrom', pipe.id);
        thisStream[thisStream.length - 1].setOutput('eto', pipe.id);
        thisStream.forEach(function(stream) { stream.pipeId = pipe.id; });
        streams = streams.concat(thisStream);
      } else {
        thisStream.setInput('efrom', pipe.id);
        thisStream.setOutput('eto', pipe.id);
        thisStream.pipeId = pipe.id;
        streams.push(thisStream);
      }
    });

    phaseStack[phaseStack.length - 1] = phaseStack[phaseStack.length - 1].concat(streams);

    while (groupStack.length > 0 && (linearGroups.length <= i + 1 || linearGroups[i + 1].indexOf(groupStack[groupStack.length - 1]) == -1)) {
      // we've reached the end of this group stack
      groupStack.pop();
      var phases = phaseStack.pop(); // do wrapping here
      var consolidated = phase.pipeline(phases);
      phaseStack[phaseStack.length - 1].push(consolidated);
    }

    if (i == linear.length - 1)
      break;

    // Unique output connections.
    var outgoing = linear[i].map(function(pipe) { return pipe.out; }).filter(
        function(v, i, s) { if (v == undefined) return false; return s.indexOf(v) == i; });

    // output connections that feed directly to the next phase. These are
    // the connections that are currently routable.
    var thisPhaseOutgoing = outgoing.filter(function(con) {
      for (var j = 0; j < con.toPipes.length; j++) {
        if (linearNames[i + 1].indexOf(con.toPipes[j].nodeName) == -1)
          return false;
      }
      return true;
    });

    // the inputs in this linear group that feed into the currently
    // routable connections.
    var thisPhaseIns = thisPhaseOutgoing.map(function(con) {
      return con.fromPipes.map(function(pipe) { return pipe.id; })
    });

    // the outputs to the next linear group that feed out of the currently
    // routable connections.
    var thisPhaseOuts = thisPhaseOutgoing.map(function(con) {
      return con.toPipes.map(function(pipe) { return pipe.id; })
    });

    var routingStage = phase.routingPhase(thisPhaseIns, thisPhaseOuts);
    phaseStack[phaseStack.length - 1].push(routingStage);
  }

  assert(phaseStack.length == 1);
  return phaseStack[0];
}

module.exports.doExperiment = definePhase({
  input: types.string,
  output: types.unit,
  arity: '1:N',
  async: true,
}, function(data, tags) {
  var require = this.options.require;
  return stageLoader.processStages(buildstageList(data, tags, require));
}, {
  require: require,
});

module.exports.typeCheckExperiment = definePhase({
  input: types.string,
  output: types.unit,
  arity: '1:N',
}, function(data, tags) {
  stageLoader.typeCheck(buildstageList(data, tags, require));
});

module.exports.getPhaseName = getPhaseName;
