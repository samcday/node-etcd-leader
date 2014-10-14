"use strict";

// These are INTEGRATION tests for the module, testing against a real etcd server.

var Etcd = require("node-etcd");
var chai = require("chai");
var expect = chai.expect;

var etcdLeader = require("../index.js");

describe("etcd-leader against a real etcd server", function() {
  this.timeout(10000);

  before(function() {
    this.etcd = new Etcd("localhost", 4001);
  });

  it("acquires fresh leader lock", function(done) {
    var leader = etcdLeader(this.etcd, "/test", "node1", 10).start();
    leader.on("elected", function() {
      // Success.
      done();
    });
  });

  it("fails leader lock over", function(done) {
    var leader1 = etcdLeader(this.etcd, "/testfailover", "node1", 1).start();
    var leader2 = etcdLeader(this.etcd, "/testfailover", "node2", 1);

    leader1.on("elected", function() {
      leader2.start();
      leader1.stop();
    });

    leader2.on("elected", function() {
      expect(leader1.isLeader()).to.be.false;
      expect(leader2.isLeader()).to.be.true;
      done();
    });
  });

  it("handles multiple members correctly", function(done) {
    this.timeout(10000);
    var leader1 = etcdLeader(this.etcd, "/testmultiple", "node1", 1).start();
    var leader2 = etcdLeader(this.etcd, "/testmultiple", "node2", 1);
    var leader3 = etcdLeader(this.etcd, "/testmultiple", "node3", 1);

    leader1.on("elected", function() {
      leader2.start();
      leader3.start();

      setTimeout(function() {
        expect(leader1.isLeader()).to.be.true;
        expect(leader2.isLeader()).to.be.false;
        expect(leader3.isLeader()).to.be.false;
        done();
      }, 1500);
    });

    leader2.on("elected", function() {
      throw new Error("leader2 should not have been elected.");
    });

    leader3.on("elected", function() {
      throw new Error("leader3 should not have been elected.");
    });
  });

  it("cleans up membership key on stop()", function(done) {
    var leader1 = etcdLeader(this.etcd, "/teststop", "node1", 100).start();
    var leader2 = etcdLeader(this.etcd, "/teststop", "node2", 100);

    leader1.on("elected", function() {
      leader2.start();

      leader2.on("elected", function() {
        leader2.stop();

        setTimeout(done, 1000);
        // done();
      });

      leader1.stop();
    });
  });

  it("does not trigger spurious elected events when stopping", function(done) {
    var leader1 = etcdLeader(this.etcd, "/testspurious", "node1", 1).start();

    var electedCalled = false;
    leader1.on("elected", function() {
      expect(electedCalled).to.be.false;
      electedCalled = true;
      leader1.on("unelected", done);
      leader1.stop();
    });
  });

  it("emits leader events on non leaders", function(done) {
    var leader1 = etcdLeader(this.etcd, "/testleader", "node1", 1).start();
    var leader2 = etcdLeader(this.etcd, "/testleader", "node2", 1);

    leader1.on("elected", function() {
      leader2.start();

      leader2.on("leader", function(node) {
        expect(node).to.eql("node1");
        expect(node).to.eql(leader2.currentLeader());
        done();
      });
    });
  });

  it("emits change of leader events on non leaders", function(done) {
    var leader1 = etcdLeader(this.etcd, "/testleaderchange", "node1", 1).start();
    var leader2 = etcdLeader(this.etcd, "/testleaderchange", "node2", 1);
    var leader3 = etcdLeader(this.etcd, "/testleaderchange", "node3", 1);

    leader1.on("elected", function() {
      leader2.start();
    });

    leader2.on("leader", function(node) {
      leader3.start();
    });

    var leader3LeaderCalled = false;
    leader3.on("leader", function(node) {
      // First call should be node1, second call should be node2.
      if (!leader3LeaderCalled) {
        expect(node).to.eql("node1");
        leader3LeaderCalled = true;
        leader1.stop();
      } else {
        expect(node).to.eql("node2");
        done();
      }
    });
  });
});
