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

const TUNNEL_CLIENT = 'C';
const TUNNEL_SERVER = 'S';

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
        init_mux_tunnel(tunnel, TUNNEL_SERVER);

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
          console.log('Create port forwarder via tunnel. Using parameters ' + JSON.stringify(v, null, '  '));
          break;
        case 'reverse':
          console.log('Create port reverser via tunnel. Using parameters ' + JSON.stringify(v, null, '  '));
          break;
        default:
          show_usage();
      }

      var tunnel = net.connect({host: v.serverAddress, port: v.serverPort}, () => {
        console.log('Connected to ' + tunnel.remoteAddress + ' TCP ' + tunnel.remotePort);
        init_mux_tunnel(tunnel, TUNNEL_CLIENT);

        switch (args[3]) {
          case 'forward':
            create_forwarder(tunnel, v.fromAddress, v.fromPort, v.toAddress, v.toPort);
            break;
          case 'reverse':
            tunnel.write(`reverse,${v.fromAddress},${v.fromPort},${v.toAddress},${v.toPort}\0`);
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

function init_mux_tunnel(tunnel, side) {
  tunnel._side = side;
  tunnel._forwarderIdMax = 0;
  tunnel._streamMap = {/*key is streamId*/};
  tunnel._targetMap = {/*key is forwarderId*/};
  tunnel._listenerMap = {/*key is forwarderId*/};
  var EMPTY_BUF = Buffer.alloc(0);
  var eventBuf = EMPTY_BUF;
  var realStream;

  tunnel.on('data', buf => {
    var restBuf = buf;
    while (restBuf && restBuf.length > 0) {
      buf = restBuf;
      restBuf = null;

      if (realStream && realStream._restLenOfDataToRead > 0) {
        //pipe tunnel incoming data to real stream
        realStream.write(buf.slice(0, realStream._restLenOfDataToRead));

        if (buf.length >= realStream._restLenOfDataToRead) {
          restBuf = buf.slice(realStream._restLenOfDataToRead);
          realStream._restLenOfDataToRead = 0;
          realStream = null;
        } else {
          realStream._restLenOfDataToRead -= buf.length;
        }
      } else {
        var pos = buf.indexOf(0);
        if (pos >= 0) {
          var event = Buffer.concat([eventBuf, buf.slice(0, pos + 1)]).toString();
          console.log('[tunnel] ' + event);
          event = event.split(',');

          if (buf.length > pos + 1) {
            restBuf = buf.slice(pos + 1);
          }
          eventBuf = EMPTY_BUF;

          if (event[0] === 'reverse') {
            create_forwarder(tunnel, event[1], event[2], event[3], event[4]);
          }
          else {
            var streamId = event[0];
            var forwarderId = streamId.split('#')[0];
            var eventType = event[1];

            if (streamId === forwarderId) {
              if (eventType === '+') {
                tunnel._targetMap[forwarderId] = {
                  fromAddress: event[2],
                  fromPort: event[3],
                  toAddress: event[4],
                  toPort: event[5]
                };
              } else if (eventType === '-') {
                delete tunnel._targetMap[forwarderId];
              }
            }
            else if (eventType === '+') {
              tunnel._streamMap[streamId] = realStream = net.connect({
                host: tunnel._targetMap[forwarderId].toAddress,
                port: tunnel._targetMap[forwarderId].toPort
              });
              pipe_stream_to_tunnel(realStream, streamId, tunnel);
            }
            else if ((realStream = tunnel._streamMap[streamId])) {
              if (eventType === '<') {
                realStream._restLenOfDataToRead = Number(event[2]).valueOf();
              } else if (eventType === '!') {
                realStream.end();
              } else if (eventType === '-') {
                realStream.destroy();
                delete tunnel._streamMap[streamId];
              } else {
                console.log('wrong event type ' + eventType);
                tunnel.destroy();
              }
            }
          }
        } else {
          eventBuf = Buffer.concat([eventBuf, buf]);
        }
      }
    }
  }).on('close', () => {
    if (side == TUNNEL_SERVER) {
      for (var streamId in tunnel._streamMap) {
        tunnel._streamMap[streamId].destroy();
        tunnel._streamMap = {};
      }
      for (var listenerId in tunnel._listenerMap) {
        tunnel._listenerMap[listenerId].close();
        tunnel._listenerMap = {};
      }
      tunnel._targetMap = {};
    } else {
      process.exit(0);
    }
  }).on('error', e => {
    console.log(e.message);
  });
}

function create_forwarder(tunnel, fromAddress, fromPort, toAddress, toPort) {
  var forwarderId = tunnel._side + '/' + (++tunnel._forwarderIdMax).toString(16);
  var streamIdMax = 0;
  net.createServer({allowHalfOpen: true}, realStream => {
    var streamId = forwarderId + '#' + (++streamIdMax).toString(16);
    tunnel._streamMap[streamId] = realStream;

    tunnel.write(`${streamId},+\0`);

    pipe_stream_to_tunnel(realStream, streamId, tunnel);

  }).listen({host: fromAddress, port: fromPort}, function () {
    console.log('[Forwarder] Listening TCP ' + this.address().port + ' of ' + this.address().address);
    tunnel._listenerMap[forwarderId] = this;
    tunnel.write(`${forwarderId},+,${fromAddress},${fromPort},${toAddress},${toPort}\0`);
  }).on('close', () => {
    delete tunnel._listenerMap[forwarderId];
    tunnel.write(`${forwarderId},-\0`);
  }).on('error', e => {
    console.log(e.message);
  });
}

function pipe_stream_to_tunnel(realStream, streamId, tunnel) {
  realStream
    .on('data', buf => {
      tunnel.cork();
      tunnel.write(`${streamId},<,${buf.length}\0`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', () => {
      tunnel.write(`${streamId},.\0`);
    })
    .on('close', () => {
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId},-\0`);
    })
    .on('error', e => {
      console.log(e.message);
    });
}

main();
