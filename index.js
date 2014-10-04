"use strict";

var events  = require("events");
var util    = require("util");
var debug   = require("debug")("etcd-leader");

// TODO:
// * Handle timeouts in refreshing membership key
// * tests. lots of them. test every error case. 100% coverage. kthx.

function EtcdLeader(etcd, key, name, ttl) {
  events.EventEmitter.call(this);

  if (!etcd) {
    throw new Error("etcd is required");
  }

  if (!key) {
    throw new Error("node key not specified");
  }

  if (!name) {
    throw new Error("node name not specified");
  }

  this._etcd = etcd;
  this._key = String(key);
  this._name = String(name);
  this._ttl = parseInt(ttl, 10) || 10;

  this._isLeader = false;
  this._currentLeader = undefined;
}

util.inherits(EtcdLeader, events.EventEmitter);

EtcdLeader.prototype.start = function() {
  if (this._started) {
    return;
  }

  var self = this;
  this._started = true;

  process.nextTick(function() {
    if (!self._started) {
      return;
    }

    self._createReq = self._etcd.create(self._key, self._name, { ttl: self._ttl }, function(err, result) {
      self._createReq = null;

      if (err) {
        return self.handleError(err);
      }

      var key = result.node.key,
          modifiedIndex = result.node.modifiedIndex;

      debug("Created membership key: " + key);

      self._checkLeader(key);
      self._refresh(key, modifiedIndex);
    });
  });

  return this;
};

EtcdLeader.prototype.stop = function() {
  if (!this._started) {
    return;
  }

  if (this._createReq) {
    this._createReq.abort();
    this._createReq = null;
  }

  if (this._leaderCheck) {
    this._leaderCheck.abort();
    this._leaderCheck = null;
  }

  if (this._precedingWatch) {
    this._precedingWatch.abort();
    this._precedingWatch = null;
  }

  if (this._refreshTimer) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = null;
  }

  if (this._refreshReq) {
    this._refreshReq.abort();
    this._refreshReq = null;
  }

  this._started = false;

  return this;
};

// Check the election key, fire event if we're leader.
// Otherwise, start watching key before ours for changes.
EtcdLeader.prototype._checkLeader = function(ourKey) {
  var self = this;
  this._leaderCheck = this._etcd.get(this._key, {sorted: true}, function(err, result) {
    self._leaderCheck = null;
    if (err) {
      return self.handleError(err);
    }

    var nodes = result.node.nodes;

    if(nodes[0].key === ourKey) {
      // We're leader. Nothing needed here but emitting an event.
      if (!self._isLeader) {
        self._isLeader = true;
        self.emit("elected");
      }

      return;
    }

    if (self._isLeader === true) {
      self._isLeader = false;
      self.emit("unelected");
    }

    if (nodes[0].value !== self._currentLeader) {
      self._currentLeader = nodes[0].value;
      self.emit("leader", self._currentLeader);
    }

    // Find the node that immediately precedes us.
    var precedingNode = null;
    for (var i = 0, len = nodes.length; i < len; i++) {
      if (nodes[i].key === ourKey) {
        precedingNode = nodes[i-1];
        break;
      }
    }
 
    if (precedingNode === null) {
      return self.handleError(err);
    }

    self._precedingWatch = self._etcd.get(precedingNode.key, { wait: true, waitIndex: precedingNode.modifiedIndex + 1 }, function(err, node) {
      self._precedingWatch = null;

      if (err) {
        return self.handleError(err);
      }

      self._checkLeader(ourKey);
    });
  });
};

EtcdLeader.prototype._refresh = function(key, modifiedIndex) {
  var self = this;

  self._refreshTimer = setTimeout(function() {
    self._refreshTimer = null;

    debug("Refreshing membership key " + key + " from index " + modifiedIndex);
    self._refreshReq = self._etcd.set(key, self._name, { ttl: self._ttl, prevIndex: modifiedIndex }, function(err, result) {
      if (err) {
        return self.handleError(err);
      }

      // TODO: check result.
      debug("Successfully refreshed membership key", result);
      self._refresh(key, result.node.modifiedIndex);
    });
  }, this._ttl * 500);
};

EtcdLeader.prototype.handleError = function(err) {
  this.stop();
  this.emit("error", err);
};

EtcdLeader.prototype.isRunning = function() {
  return this._started;
}

module.exports = function(etcd, key, name, ttl) {
  return new EtcdLeader(etcd, key, name, ttl);
};
