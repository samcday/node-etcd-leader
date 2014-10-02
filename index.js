"use strict";

var events  = require("events");
var util    = require("util");
var debug   = require("debug")("etcd-leader");

// TODO:
// * Handle timeouts in refreshing membership key
// * tests. lots of them. test every error case. 100% coverage. kthx.

function EtcdLeader(etcd, key, name, ttl) {
  events.EventEmitter.call(this);

  this._etcd = etcd;
  this._key = String(key);
  this._name = String(name);
  this._ttl = parseInt(ttl, 10) || 10;

  this._isLeader = false;
  this._currentLeader = undefined;

  if (!this._etcd) {
    throw new Error("etcd is required");
  }

  if (!this._key) {
    throw new Error("node key not specified");
  }

  if (!this._name) {
    throw new Error("Node name not specified");
  }
}

util.inherits(EtcdLeader, events.EventEmitter);

EtcdLeader.prototype.start = function() {
  var self = this;

  this._etcd.create(this._key, this._name, { ttl: this._ttl }, function(err, result) {
    if (err) {
      return self.emit("error", err);
    }

    var key = result.node.key,
        modifiedIndex = result.node.modifiedIndex;

    debug("Created membership key: " + key);

    self._checkLeader(key);
    self._refresh(key, modifiedIndex);
  });

  return this;
};

EtcdLeader.prototype.stop = function() {
  return this;
};

// Check the election key, fire event if we're leader.
// Otherwise, start watching key before ours for changes.
EtcdLeader.prototype._checkLeader = function(ourKey) {
  var self = this;
  this._etcd.get(this._key, {sorted: true}, function(err, result) {
    if (err) {
      return self.emit("error", err);
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
      return self.emit("error", new Error("Error determing current leader"));
    }

    self._etcd.get(precedingNode.key, { wait: true, waitIndex: precedingNode.modifiedIndex + 1 }, function(err, node) {
      if (err) {
        return self.emit("error", err);
      }

      self._checkLeader(ourKey);
    });
  });
};

EtcdLeader.prototype._refresh = function(key, modifiedIndex) {
  var self = this;

  this._refreshTimer = setTimeout(function() {
    debug("Refreshing membership key " + key + " from index " + modifiedIndex);
    self._etcd.set(key, self._name, { ttl: self._ttl, prevIndex: modifiedIndex }, function(err, result) {
      if (err) {
        return self.emit("error", err);
      }

      // TODO: check result.
      debug("Successfully refreshed membership key", result);
      self._refresh(key, result.node.modifiedIndex);
    });
  }, this._ttl * 500);
};

module.exports = function(etcd, key, name, ttl) {
  return new EtcdLeader(etcd, key, name, ttl);
};
