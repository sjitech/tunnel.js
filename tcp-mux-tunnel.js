#!/usr/bin/env node
'use strict';

var net = require("net");

function show_usage() {
  console.log('Create a single connection as mux tunnel, so you can pipe multiple connections between local and remotes, even in a restricted network.');
  console.log('Usage:');
  console.log(' tcp-mux-tunnel.js server <listenAddress> <listenPort>');
  console.log(' tcp-mux-tunnel.js connect <serverAddress> <serverPort> forward <fromAddress>   <fromPort>   <toAddress_R> <toPort_R>');
  console.log(' tcp-mux-tunnel.js connect <serverAddress> <serverPort> reverse <fromAddress_R> <fromPort_R> <toAddress>   <toPort>');
  console.log('Notes:');
  console.log(' The "_R" suffix means the address and port is in sense of the tunnel server.');
  process.exit(1);
}

function main() {
  //nodejs args is start from the 3rd.
  var args = process.argv.slice(2);
  var v;

  switch (args[0]) {
    case 'server':
      v = {
        listenAddress: args[1],
        listenPort: args[2]
      };
      console.log('Create mux tunnel server. Using parameters ' + JSON.stringify(v, null, '  '));

      net.createServer({allowHalfOpen: false}, tunnel => {
        console.log('incoming from ' + tunnel.remoteAddress + ' ' + tunnel.remotePort);
        init_mux_tunnel(tunnel);

      }).listen({host: v.listenAddress, port: v.listenPort}, function () {
        console.log('Listening TCP ' + this.address().port + ' of ' + this.address().address);
      }).on('error', (e) => {
        console.log(e.message)
      });
      break;
    case 'connect':
      v = {
        serverAddress: args[1],
        serverPort: args[2],
        fromAddress: args[4],
        fromPort: args[5],
        toAddress: args[6],
        toPort: args[7],
      };
      switch (args[3]) {
        case 'forward':
          console.log('Create mux tunnel client with port forwarder. Using parameters ' + JSON.stringify(v, null, '  '));
          break;
        case 'reverse':
          console.log('Create mux tunnel client with port reverser. Using parameters ' + JSON.stringify(v, null, '  '));
          break;
        default:
          show_usage();
      }

      var tunnel = net.connect({host: v.serverAddress, port: v.serverPort}, () => {
        console.log('Connected to ' + tunnel.remoteAddress + ' TCP ' + tunnel.remotePort);

        init_mux_tunnel(tunnel);

        switch (args[3]) {
          case 'forward':
            create_forwarder(tunnel, v.fromAddress, v.fromPort, v.toAddress, v.toPort);
            break;
          case 'reverse':
            tunnel.write(JSON.stringify({
              op: 'reverse',
              fromAddress: v.fromAddress,
              fromPort: v.fromPort,
              toAddress: v.toAddress,
              toPort: v.toPort
            }));
            break;
        }
      }).on('error', (e) => {
        console.log(e.message)
      });

      break;
    default:
      show_usage();
  }
}

function init_mux_tunnel(tunnel) {
  tunnel.virtStreamLastId = 0;
  tunnel.virtStreamMap = {};
  var tmpBuf = Buffer.alloc(0);
  var currentVirtStream;

  tunnel.on('data', buf => {
    if (currentVirtStream) {
      //pipe tunnel incoming data to real stream
      currentVirtStream.realStream.write(buf.slice(0, currentVirtStream.length));

      if (buf.length > currentVirtStream.length) {
        tunnel.unshift(buf.slice(currentVirtStream.length));
        currentVirtStream = null;
      } else if (buf.length == currentVirtStream.length) {
        currentVirtStream = null;
      } else {
        currentVirtStream.length -= buf.length;
      }
    } else {
      var pos = buf.indexOf('}');
      if (pos >= 0) {
        console.log('request: ' + Buffer.concat([tmpBuf, buf.slice(0, pos + 1)]).toString());
        var req = JSON.parse(Buffer.concat([tmpBuf, buf.slice(0, pos + 1)]).toString());
        if (buf.length > pos + 1) {
          tunnel.unshift(buf.slice(pos + 1));
        }
        tmpBuf = tmpBuf.slice(0, 0);
        var virtStream;

        switch (req.op) {
          case 'reverse':
            create_forwarder(tunnel, req.fromAddress, req.fromPort, req.toAddress, req.toPort);
            break;
          case 'connect':
            tunnel.virtStreamMap[req.virtStreamId] = virtStream = {
              realStream: net.connect({host: req.host, port: req.port})
            };
            pipe_stream_to_tunnel(virtStream.realStream, req.virtStreamId, tunnel);
            break;
          default:
            console.log(req);
            virtStream = tunnel.virtStreamMap[req.virtStreamId];
            if (!virtStream) {
              break;
            }
            switch (req.op) {
              case 'on data':
                virtStream.length = req.length;
                currentVirtStream = virtStream;
                break;
              case 'on end':
                virtStream.realStream.end();
                break;
              case 'on close':
                virtStream.realStream.destroy();
                delete tunnel.virtStreamMap[req.virtStreamId];
                break;
              case 'on error':
                console.log('Remote error: ' + req.msg);
                virtStream.realStream.destroy();
                delete tunnel.virtStreamMap[req.virtStreamId];
                break;
              default:
                console.log('wrong op ' + req.op);
                process.exit(1);
            }
        }
      } else {
        tmpBuf = Buffer.concat([tmpBuf, buf]);
      }
    }
  }).on('close', () => {
    process.exit(0);
  }).on('error', e => {
    console.log(e.message);
    process.exit(1);
  });
}

function create_forwarder(tunnel, fromAddress, fromPort, toAddress, toPort) {
  net.createServer({allowHalfOpen: true}, realStream => {
    var virtStreamId = ++tunnel.virtStreamLastId;

    tunnel.write(JSON.stringify({
      op: 'connect',
      virtStreamId: virtStreamId,
      host: toAddress,
      port: toPort
    }));

    tunnel.virtStreamMap[virtStreamId] = {
      realStream: realStream
    };

    pipe_stream_to_tunnel(realStream, virtStreamId, tunnel);

  }).listen({host: fromAddress, port: fromPort}, function () {
    console.log('[Forwarder] Listening TCP ' + this.address().port + ' of ' + this.address().address);
  });

}

function pipe_stream_to_tunnel(realStream, virtStreamId, tunnel) {
  realStream
    .on('data', buf => {
      tunnel.write(JSON.stringify({
        op: 'on data',
        virtStreamId: virtStreamId,
        length: buf.length
      }));
      tunnel.write(buf);
    })
    .on('end', () => {
      tunnel.write(JSON.stringify({
        op: 'on end',
        virtStreamId: virtStreamId
      }));
    })
    .on('close', () => {
      tunnel.write(JSON.stringify({
        op: 'on close',
        virtStreamId: virtStreamId
      }));
      delete tunnel.virtStreamMap[virtStreamId];
    })
    .on('error', e => {
      console.log(e.message);
      tunnel.write(JSON.stringify({
        op: 'on error',
        virtStreamId: virtStreamId,
        msg: e.message
      }));
      delete tunnel.virtStreamMap[virtStreamId];
    });
}

main();
