#!/usr/bin/env node
'use strict';

const net = require("net");

function show_usage() {
  console.log('Create a single connection as mux tunnel, so you can pipe multiple connections between local and remotes, even in a restricted network.');
  console.log('Usage:');
  console.log(' tcp-mux-tunnel.js listen  <host port> [tunnelAction]...');
  console.log(' tcp-mux-tunnel.js connect <host port> [from <host port>] [tunnelAction]...');
  console.log('The above two commands will further read Tunnel Actions from the rest command line and standard input.');
  show_usage_tunnel_action();
  process.exit(1);
}

function show_usage_tunnel_action() {
  console.log('The Tunnel Actions are:');
  console.log('  forward   <host port>  <r_host port>');
  console.log('  reverse <r_host port>    <host port>');
  console.log('  close     <host port>');
  console.log('  r-close <r_host port>');
  console.log('Notes:');
  console.log(' The "r-" prefix means the host and port is in sense of the tunnel peer.');
}

const TUNNEL_CLIENT = 'C';
const TUNNEL_SERVER = 'S';

function main() {
  //nodejs args is start from the 3rd.
  let args = process.argv.slice(2);
  let v;
  let tunnelMap = {};

  switch (args.shift()) {
    case 'listen':
      v = {
        host: args.shift(),
        port: args.shift()
      };
      console.log('Create mux tunnel server. Using parameters ' + JSON.stringify(v, null, '  '));

      net.createServer({allowHalfOpen: false}, tunnel => {
        tunnel._tag = '[Tunnel'+(getTimestampShort()+'] ');
        console.log(tunnel._tag + 'Connected from ' + tunnel.remoteAddress + ':' + tunnel.remotePort);

        init_mux_tunnel(tunnel, TUNNEL_SERVER);

        tunnelMap[tunnel._tag] = tunnel;
        tunnel.on('close', () => {
          delete tunnelMap[tunnel._tag];
        });
      }).listen(v, function () {
        console.log('[TunnelServer] Listening ' + this.address().address + ':' + this.address().port);
      }).on('error', function(e) {
        console.log('[TunnelServer] ' + e.message);
        this.close();
      }).on('close', function () {
        console.log('[TunnelServer] closed')
      });
      break;
    case 'connect':
      v = {
        host: args.shift(),
        port: args.shift(),
      };
      if (args[0] === 'from') {
        args.shift();
        v.localAddress = args.shift();
        v.localPort = args.shift();
      }
        console.log('Connect to tunnel server. Using parameters ' + JSON.stringify(v, null, '  '));

        const tunnel = net.connect(v);

      tunnel._tag = '[Tunnel'+getTimestampShort()+'] ';

      init_mux_tunnel(tunnel, TUNNEL_CLIENT);

      tunnelMap[tunnel._tag] = tunnel;

      break;
    default:
      show_usage();
  }

  while(args.length> 0) {

  }
}

function run_tunnel_action(tunnel, args) {
  let v;
  switch (args.shift()) {
    case 'forward':
      v = {
        fromAddress: args.shift(),
        fromPort: args.shift(),
        toAddress: args.shift(),
        toPort: args.shift()
      };
      console.log('Create port forwarder via tunnel. Using parameters ' + JSON.stringify(v, null, '  '));
        create_forwarder_listener(tunnel, v.fromAddress, v.fromPort, v.toAddress, v.toPort);
      break;
    case 'reverse':
      v = {
        fromAddress: args.shift(),
        fromPort: args.shift(),
        toAddress: args.shift(),
        toPort: args.shift()
      };
      console.log('Create port reverser via tunnel. Using parameters ' + JSON.stringify(v, null, '  '));
      tunnel.write(`\treverse\t${v.fromAddress}\t${v.fromPort}\t${v.toAddress}\t${v.toPort}\n`);
      break;
    default:
      show_usage_tunnel_action();
  }
}

function init_mux_tunnel(tunnel, side) {
  tunnel._side = side;
  tunnel._forwarderIdMax = 0;
  tunnel._streamMap = {/*key is streamId*/};
  tunnel._targetMap = {/*key is forwarderId*/};
  tunnel._listenerMap = {/*key is forwarderId*/};
  const EMPTY_BUF = Buffer.alloc(0);
  let eventBuf = EMPTY_BUF;
  const EOF_CODE = '\n'.charAt(0);
  let curRealStream;

  tunnel.on('data', buf => {
      let restBuf = buf;
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
          const pos = buf.indexOf(EOF_CODE);
          if (pos >= 0) {
            let event_s = Buffer.concat([eventBuf, buf.slice(0, pos)]).toString();
            if (buf.length > pos + 1) {
              restBuf = buf.slice(pos + 1);
            }
            eventBuf = EMPTY_BUF;

            console.log(tunnel._tag + event_s);
            const event = event_s.split('\t');
            const streamId = event[0];
            const eventName = event[1];

            if (streamId) {
              const forwarderId = streamId.split('#')[0];

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
                let realStream = null;
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
                  let len;
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
    console.log(tunnel._tag + 'closed');
    if (side == TUNNEL_SERVER) {
      for (let streamId in tunnel._streamMap) {
        tunnel._streamMap[streamId].destroy();
        tunnel._streamMap = {};
      }
      for (let forwarderId in tunnel._listenerMap) {
        tunnel._listenerMap[forwarderId].listener.close();
        tunnel._listenerMap = {};
      }
      tunnel._targetMap = {};
    } else {
      process.exit(0);
    }
  }).on('error', e => {
    console.log(tunnel._tag + + e.message);
  });
}

function create_forwarder_listener(tunnel, fromAddress, fromPort, toAddress, toPort) {
  const forwarderId = tunnel._side + '/' + (++tunnel._forwarderIdMax).toString(16);
  let streamIdMax = 0;

  net.createServer({allowHalfOpen: true}, realStream => {
    console.log('[stream] Connected from ' + realStream.remoteAddress + ':' + realStream.remotePort);
    const streamId = forwarderId + '#' + (++streamIdMax).toString(16);
    tunnel._streamMap[streamId] = realStream;

    tunnel.write(`${streamId}\t+\n`);

    pipe_stream_to_tunnel(realStream, streamId, tunnel);

  }).listen({host: fromAddress, port: fromPort}, function () {
    console.log('[ForwarderListener] Listening TCP ' + this.address().port + ' of ' + this.address().address);
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
    console.log('[ForwarderListener] Closed');
    if (tunnel._listenerMap[forwarderId]) {
      delete tunnel._listenerMap[forwarderId];
      tunnel.write(`${forwarderId}\t-\n`);
    }
  }).on('error', function(e) {
    console.log('[ForwarderListener] ' + e.message);
    this.close();
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
      console.log('[stream] ended');
      tunnel.write(`${streamId}\t!\n`);
    })
    .on('close', () => {
      console.log('[stream] closed');
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId}\t-\n`);
    })
    .on('error', e => {
      console.log('[stream] ' + e.message);
    });
}

function getTimestampShort() {
  let dt = new Date(), seqStr = '';
  if (dt.valueOf() === getTimestampShort.dtMs) {
    seqStr = '.' + String.fromCharCode(65 + (seqStr = String(++getTimestampShort.seq)).length - 1) + seqStr; //make sortable number. 9->A9 10->B10 so B10 > A9
  } else {
    getTimestampShort.seq = 0;
    getTimestampShort.dtMs = dt.valueOf();
  }
  return pad234(dt.getMonth() + 1, 2) + pad234(dt.getDate(), 2) + pad234(dt.getHours(), 2) + pad234(dt.getMinutes(), 2) + pad234(dt.getSeconds(), 2) + '.' + pad234(dt.getMilliseconds(), 3) + seqStr;
}

function pad234(d, len/*2~4*/) {
  return len === 2 ? ((d < 10) ? '0' + d : d.toString()) : len === 3 ? ((d < 10) ? '00' + d : (d < 100) ? '0' + d : d.toString()) : len === 4 ? ((d < 10) ? '000' + d : (d < 100) ? '00' + d : (d < 1000) ? '0' + d : d.toString()) : d;
}




main();

if (!process) { //just to prevent JSLint error
  console.log({remoteAddress: "", remotePort: 8080, cork: Function, uncork: Function, alloc: Function});
}