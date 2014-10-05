"use strict";

// These are UNIT tests for the module, testing with a mocked node-etcd library.

var chai = require("chai");
var sinon = require("sinon");
var expect = chai.expect;

var etcdLeader = require("../index.js");

function setupFakeTimers() {
  var clock = sinon.useFakeTimers();
  after(function() {
    clock.restore();
  });
  return clock;
}

describe("etcd-leader", function() {
  it("should fail if no etcd client provided", function() {
    expect(function() {
      etcdLeader();
    }).to.throw(/etcd is required/);
  });

  it("should fail on invalid leader key", function() {
    expect(function() {
      etcdLeader({});
    }).to.throw(/node key not specified/);
  });

  it("should fail on invalid node name", function() {
    expect(function() {
      etcdLeader({}, "/foo");
    }).to.throw(/node name not specified/);
  });

  it("should default TTL", function() {
    var leader = etcdLeader({}, "/foo", "bar");
    expect(leader._ttl).to.equal(10);
  });

  it("should coerce TTL", function() {
    var leader = etcdLeader({}, "/foo", "bar", "123");
    expect(leader._ttl).to.eql(123); 
  });

  describe("on start()", function() {
    it("should return self", function() {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123");
      expect(leader.start()).to.eql(leader);
    });

    it("should indicate isRunning()", function() {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      expect(leader.isRunning()).to.be.true;
    });

    it("should ignore multiple calls", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      leader.start();

      process.nextTick(function() {
        expect(mockEtcd.create.callCount).to.eql(1);
        done();
      });
    });

    it("should not create membership key until next tick", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      sinon.assert.notCalled(mockEtcd.create);

      process.nextTick(function() {
        sinon.assert.calledWith(mockEtcd.create, "/foo", "bar", { ttl: 123 });
        done();
      });
    });

    it("should not start if immediately stopped", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();

      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      sinon.assert.notCalled(mockEtcd.create);
      leader.stop();

      process.nextTick(function() {
        sinon.assert.notCalled(mockEtcd.create);
        done();
      });
    });

    it("should handle failures in creating membership key", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      mockEtcd.create.callsArgWith(3, new Error("An etcd error!"));
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();

      leader.on("error", function(err) {
        expect(err.message).to.match(/An etcd error/);
        expect(leader.isRunning()).to.be.false;
        done();
      });
    });

    it("should check for leader after creating membership key", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      mockEtcd.create.callsArgWith(3, undefined, {
        node: {
          key: "/foo/123",
          modifiedIndex: 123,
        }
      });

      mockEtcd.get = sinon.stub();

      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();

      after(function() {
        leader.stop();
      });

      process.nextTick(function() {
        sinon.assert.calledWith(mockEtcd.get, "/foo", { sorted: true });
        done();
      });
    });

    it("should handle failure when checking for leader", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      mockEtcd.create.callsArgWith(3, undefined, {
        node: {
          key: "/foo/123",
          modifiedIndex: 123,
        }
      });

      mockEtcd.get = sinon.stub();
      mockEtcd.get.callsArgWith(2, new Error("An etcd error"));

      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      leader.on("error", function(err) {
        expect(err.message).to.match(/An etcd error/);
        expect(leader.isRunning()).to.be.false;
        done();
      })
    });

    it("should begin refreshing membership key regularly", function(done) {
      var clock = setupFakeTimers();

      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      mockEtcd.create.callsArgWith(3, undefined, {
        node: {
          key: "/foo/123",
          modifiedIndex: 123,
        }
      });

      // This one is for the leader check, we just never answer it.
      mockEtcd.get = sinon.stub();

      mockEtcd.set = sinon.stub();

      var leader = etcdLeader(mockEtcd, "/foo", "bar", 10).start();

      process.nextTick(function() {
        clock.tick(4999);

        // Shouldn't be called yet.
        sinon.assert.notCalled(mockEtcd.set);

        mockEtcd.set.callsArgWith(3, undefined, {
          node: {
            modifiedIndex: 321,
          }
        });

        clock.tick(1);

        // Now it should.
        sinon.assert.calledWith(mockEtcd.set, "/foo/123", "bar", { ttl: 10, prevIndex: 123 });

        mockEtcd.set.reset();

        clock.tick(5001);
        sinon.assert.calledWith(mockEtcd.set, "/foo/123", "bar", { ttl: 10, prevIndex: 321 });

        done();
      });
    });

    it("should handle errors when refreshing membership key", function(done) {
      var clock = setupFakeTimers();

      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      mockEtcd.create.callsArgWith(3, undefined, {
        node: {
          key: "/foo/123",
          modifiedIndex: 123,
        }
      });

      mockEtcd.get = sinon.stub();
      mockEtcd.set = sinon.stub();
      mockEtcd.set.callsArgWith(3, new Error("etcd error!"));

      var leader = etcdLeader(mockEtcd, "/foo", "bar", 10).start();
      leader.on("error", function(err) {
        expect(err.message).to.match(/etcd error/);
        expect(leader.isRunning()).to.be.false;
        done();
      });

      process.nextTick(function() {
        clock.tick(5000);
      });
    });

    xit("should handle refresh timeouts", function(done) {

    });
  });

  describe("on stop()", function() {
    it("should no-op on unstarted client", function() {
      var leader = etcdLeader({}, "/foo", "bar", "123");
      leader.stop();
    });

    it("should abort initial create request", function(done) {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();

      var mockReq = { abort: sinon.stub() };
      mockEtcd.create.onCall(0).returns(mockReq);

      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();

      process.nextTick(function() {
        leader.stop();
        sinon.assert.calledOnce(mockReq.abort);
        done();
      });
    });

    it("should indicate isRunning()", function() {
      var mockEtcd = {};
      mockEtcd.create = sinon.stub();
      var leader = etcdLeader(mockEtcd, "/foo", "bar", "123").start();
      leader.stop();
      expect(leader.isRunning()).to.be.false;
    });
  });
});
