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
            create_forwarder_listener(tunnel, v.fromAddress, v.fromPort, v.toAddress, v.toPort);
            break;
          case 'reverse':
            tunnel.write(`\treverse\t${v.fromAddress}\t${v.fromPort}\t${v.toAddress}\t${v.toPort}\n`);
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
  var EOF_CODE = '\n'.charAt(0);
  var curRealStream;

  tunnel.on('data', buf => {
      var restBuf = buf;
      while (restBuf && restBuf.length > 0) {
        buf = restBuf;
        restBuf = null;

        if (curRealStream) {
          //pipe tunnel incoming data to real stream
          curRealStream.write(buf.slice(0, curRealStream._restLenOfDataToRead));

          if (buf.length >= curRealStream._restLenOfDataToRead) {
            restBuf = buf.slice(curRealStream._restLenOfDataToRead);
            curRealStream._restLenOfDataToRead = 0;
            curRealStream = null;
          } else {
            curRealStream._restLenOfDataToRead -= buf.length;
          }
        } else {
          var pos = buf.indexOf(EOF_CODE);
          if (pos >= 0) {
            var event = Buffer.concat([eventBuf, buf.slice(0, pos)]).toString();
            if (buf.length > pos + 1) {
              restBuf = buf.slice(pos + 1);
            }
            eventBuf = EMPTY_BUF;

            console.log('[tunnel] ' + event);
            event = event.split('\t');
            var streamId = event[0];
            var eventName = event[1];

            if (streamId) {
              var forwarderId = streamId.split('#')[0];

              if (streamId === forwarderId) { //listener events from peer
                if (eventName === '+') { //on listening
                  tunnel._targetMap[forwarderId] = {
                    peer: {
                      address: event[2], //just as info
                      port: event[3], //just as info
                    },
                    toAddress: event[4],
                    toPort: event[5]
                  };
                } else if (eventName === '-') { //on close
                  delete tunnel._targetMap[forwarderId];
                } else {
                  console.log('invalid event name ' + event[1]);
                  tunnel.destroy();
                  return;
                }
              }
              else { //stream events from peer
                var realStream = null;
                if (eventName === '+') { //on connect
                  try {
                    realStream = net.connect({
                      host: tunnel._targetMap[forwarderId].toAddress,
                      port: tunnel._targetMap[forwarderId].toPort
                    });
                  } catch (e) {
                    console.log('failed to connect. ' + e.message);
                  }
                  if (realStream) {
                    tunnel._streamMap[streamId] = realStream;
                    pipe_stream_to_tunnel(realStream, streamId, tunnel);
                  } else {
                    tunnel.write(`${streamId}\t-\n`);
                  }
                }
                else if (eventName === ':') { //on data
                  var len;
                  try {
                    len = parseInt(event[2], 16);
                  } catch (e) {
                    console.log('invalid data length. ' + e.message);
                    tunnel.destroy();
                    return;
                  }
                  realStream = tunnel._streamMap[streamId];
                  if (realStream && len > 0) {
                    realStream._restLenOfDataToRead = len;
                    curRealStream = realStream;
                  }
                } else if (eventName === '!') { //on end
                  realStream = tunnel._streamMap[streamId];
                  if (realStream) {
                    realStream.end();
                  }
                }
                else if (eventName === '-') { //on close
                  realStream = tunnel._streamMap[streamId];
                  if (realStream) {
                    realStream.destroy();
                    delete tunnel._streamMap[streamId];
                  }
                } else {
                  console.log('invalid event name: ' + eventName);
                  tunnel.destroy();
                  return;
                }
              }
            }
            else { //internal commands
              if (eventName === 'reverse') {
                create_forwarder_listener(tunnel, event[2], event[3], event[4], event[5]);
              } else {
                console.log('invalid event name ' + event[1]);
                tunnel.destroy();
                return;
              }
            }
          }
          else {
            eventBuf = Buffer.concat([eventBuf, buf]);
          }
        }
      }
    }
  ).on('close', () => {
    if (side == TUNNEL_SERVER) {
      for (var streamId in tunnel._streamMap) {
        tunnel._streamMap[streamId].destroy();
        tunnel._streamMap = {};
      }
      for (var forwarderId in tunnel._listenerMap) {
        tunnel._listenerMap[forwarderId].listener.close();
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

function create_forwarder_listener(tunnel, fromAddress, fromPort, toAddress, toPort) {
  var forwarderId = tunnel._side + '/' + (++tunnel._forwarderIdMax).toString(16);
  var streamIdMax = 0;

  net.createServer({allowHalfOpen: true}, realStream => {
    var streamId = forwarderId + '#' + (++streamIdMax).toString(16);
    tunnel._streamMap[streamId] = realStream;

    tunnel.write(`${streamId}\t+\n`);

    pipe_stream_to_tunnel(realStream, streamId, tunnel);

  }).listen({host: fromAddress, port: fromPort}, function () {
    console.log('[Forwarder] Listening TCP ' + this.address().port + ' of ' + this.address().address);
    tunnel._listenerMap[forwarderId] = {
      listener: this,
      address: fromAddress,
      port: fromPort,
      peer: {
        toAddress: toAddress,
        toPort: toPort
      }
    };
    tunnel.write(`${forwarderId}\t+\t${fromAddress},${fromPort},${toAddress},${toPort}\n`);

  }).on('close', () => {
    delete tunnel._listenerMap[forwarderId];
    tunnel.write(`${forwarderId}\t-\n`);

  }).on('error', e => {
    console.log(e.message);
  });
}

function pipe_stream_to_tunnel(realStream, streamId, tunnel) {
  realStream
    .on('data', buf => {
      tunnel.cork();
      tunnel.write(`${streamId}\t:\t${buf.length.toString(16)}\n`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', () => {
      tunnel.write(`${streamId}\t!\n`);
    })
    .on('close', () => {
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId}\t-\n`);
    })
    .on('error', e => {
      console.log(e.message);
    });
}

main();
