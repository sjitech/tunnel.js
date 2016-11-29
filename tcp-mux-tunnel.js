#!/usr/bin/env node
'use strict';

const net = require("net");

function show_usage() {
  console.log('Create a tunnel for port forwarding/reversing.');
  console.log('Usage of Tunnel Server:');
  console.log(' tcp-mux-tunnel.js listen  <host port>');
  console.log('Usage of Tunnel Client:');
  console.log(' tcp-mux-tunnel.js connect <host port> [from <host port>] [tunnelAction]...');
  console.log('Note: Tunnel Client will also read Tunnel Actions from standard input.');
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
  console.log(' The "r-" prefix means the host and port is in sense of the Tunnel Server.');
}

let isTunnelServer;

function main() {
  //script args is start from the 3rd.
  let args = process.argv.slice(2);
  let v;

  switch (args.shift()) {
    case 'listen':
      isTunnelServer = true;
      v = {
        host: args.shift(),
        port: args.shift()
      };
      console.log('Create mux tunnel server ' + JSON.stringify(v, null, '  '));
      if (v.host === '*') {
        delete v.host;
      }

      net.createServer({allowHalfOpen: false}, function (tunnel) {
        let tag = '[Tunnel:' + tunnel.remoteAddress + ':' + tunnel.remotePort + '] ';
        console.log(tag + 'Connected');

        init_mux_tunnel(tunnel, tag);

      }).listen(v, function () {
        console.log('[TunnelServer] Listening ' + this.address().address + ':' + this.address().port);
      }).on('error', function (e) {
        console.log('[TunnelServer] ' + e.message);
        process.exit(1);
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
      console.log('Connect to tunnel server ' + JSON.stringify(v, null, '  '));
      if (v.localAddress === '*') {
        delete v.localAddress;
      }

      const tunnel = net.connect(v);

      init_mux_tunnel(tunnel, '[Tunnel] ');

      while (args.length) {
        run_tunnel_action(tunnel, args);
      }

      require('readline').createInterface({
        input: process.stdin
      }).on('line', function (line) {
        args = line.trim().split(/\s+/);
        while (args.length) {
          run_tunnel_action(tunnel, args);
        }
      });

      break;
    default:
      show_usage();
  }
}

function run_tunnel_action(tunnel, args) {
  switch (args.shift()) {
    case 'forward':
      create_forwarder_listener(tunnel, args.shift(), args.shift(), args.shift(), args.shift());
      break;
    case 'close':
      close_forwarder_listener(tunnel, args.shift(), args.shift());
      break;
    case 'reverse':
    case 'r-forward':
      tunnel.write(`\tforward\t${args.shift()}\t${args.shift()}\t${args.shift()}\t${args.shift()}\n`);
      break;
    case 'r-close':
      tunnel.write(`\tclose\t${args.shift()}\t${args.shift()}\n`);
      break;
    default:
      show_usage_tunnel_action();
  }
}

function init_mux_tunnel(tunnel, tunnelTag) {
  tunnel._streamMap = {/*key is streamId*/};
  tunnel._targetMap = {/*key is forwarderId*/};
  tunnel._listenerMap = {/*key is forwarderId*/};
  const EMPTY_BUF = Buffer.alloc(0);
  let eventBuf = EMPTY_BUF;
  const EOF_CODE = '\n'.charAt(0);
  let curRealStream;

  tunnel.on('data', function (buf) {
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

          console.log(tunnelTag + event_s);
          const args = event_s.split('\t');

          let res = handle_tunnel_event(tunnel, args);

          if (res === false) break;
          curRealStream = res;
        }
        else {
          eventBuf = Buffer.concat([eventBuf, buf]);
        }
      }
    }
  }).on('close', function () {
    console.log(tunnelTag + 'closed');
    if (isTunnelServer) {
      for (let streamId in tunnel._streamMap) {
        tunnel._streamMap[streamId].destroy();
        tunnel._streamMap = {};
      }
      for (let forwarderId in tunnel._listenerMap) {
        tunnel._listenerMap[forwarderId].server.close();
        tunnel._listenerMap = {};
      }
      tunnel._targetMap = {};
    } else {
      process.exit(0);
    }
  }).on('error', function (e) {
    console.log(tunnelTag + e.message);
  }).on('connect', function () {
    console.log(tunnelTag + 'Connected');
  });
}

function handle_tunnel_event(tunnel, args) {
  let invalid = false;
  const streamId = args.shift();
  const eventName = args.shift();

  if (streamId) {
    const forwarderId = streamId.split('#')[0];

    if (streamId === forwarderId) { //listener events from peer
      switch (eventName) {
        case '+': //on listening
          tunnel._targetMap[forwarderId] = {
            peer: {
              address: args.shift(), //just as info
              port: args.shift(), //just as info
            },
            toAddress: args.shift(),
            toPort: args.shift()
          };
          break;
        case '-': //on close
          delete tunnel._targetMap[forwarderId];
          break;
        default:
          invalid = true;
      }
    }
    else { //stream events from peer
      let realStream = tunnel._streamMap[streamId];
      switch (eventName) {
        case '+':  //on connect
          try {
            realStream = net.connect({
              host: tunnel._targetMap[forwarderId].toAddress,
              port: tunnel._targetMap[forwarderId].toPort
            });

            tunnel._streamMap[streamId] = realStream;
            pipe_stream_to_tunnel(realStream, streamId, tunnel);

          } catch (e) {
            console.log('failed to connect. ' + e.message);
            tunnel.write(`${streamId}\t-\n`);
          }
          break;
        case ':': //on data
          let len;
          try {
            len = parseInt(args.shift(), 16);
          } catch (e) {
            invalid = true;
            break;
          }
          if (realStream && len > 0) {
            realStream._restLenOfDataToRead = len;
            return realStream;
          }
          break;
        case '!': //on end
          if (realStream) {
            realStream.end();
          }
          break;
        case '-': //on close
          if (realStream) {
            realStream.destroy();
            delete tunnel._streamMap[streamId];
          }
          break;
        default:
          invalid = true;
      }
    }
  } else { //internal commands
    switch (eventName) {
      case 'forward':
        create_forwarder_listener(tunnel, args.shift(), args.shift(), args.shift(), args.shift());
        break;
      case 'close':
        close_forwarder_listener(tunnel, args.shift(), args.shift());
        break;
      default:
        invalid = true;
    }
  }

  if (invalid) {
    console.log('invalid event');
    tunnel.destroy();
    return false;
  }
}

let lastForwarderId = 0;

function create_forwarder_listener(tunnel, fromAddress, fromPort, toAddress, toPort) {
  console.log((isTunnelServer ? ('[Tunnel:' + tunnel.remoteAddress + ':' + tunnel.remotePort + '] ') : '' )
    + 'Create port forwarder ' + JSON.stringify({fromAddress, fromPort, toAddress, toPort}, null, '  '));
  const forwarderId = (isTunnelServer ? 'S' : 's') + (++lastForwarderId).toString(16);
  let streamIdMax = 0;

  try {
    net.createServer({allowHalfOpen: true}, function (realStream) {
      const streamId = forwarderId + '#' + (++streamIdMax).toString(16);
      console.log('[Stream:' + streamId + '] Connected from ' + realStream.remoteAddress + ':' + realStream.remotePort);
      tunnel._streamMap[streamId] = realStream;

      tunnel.write(`${streamId}\t+\n`);

      pipe_stream_to_tunnel(realStream, streamId, tunnel);

    }).listen({host: fromAddress === '*' ? undefined : fromAddress, port: fromPort}, function () {
      console.log('[Forwarder:' + forwarderId + '] Listening' + this.address().address + ':' + this.address().port);
      tunnel._listenerMap[forwarderId] = {
        server: this,
        address: fromAddress,
        port: fromPort,
        peer: {
          toAddress: toAddress,
          toPort: toPort
        }
      };
      tunnel.write(`${forwarderId}\t+\t${fromAddress}\t${fromPort}\t${toAddress}\t${toPort}\n`);

    }).on('close', function () {
      console.log('[Forwarder:' + forwarderId + '] Closed');
      delete tunnel._listenerMap[forwarderId];
      tunnel.write(`${forwarderId}\t-\n`);
    }).on('error', function (e) {
      console.log('[Forwarder:' + forwarderId + '] ' + e.message);
      this.close();
    });
  } catch (e) {
    console.log('create_forwarder_listener ' + e.message);
  }
}

function close_forwarder_listener(tunnel, listenerAddress, listenerPort) {
  console.log('Close port forwarder ' + JSON.stringify({listenerAddress, listenerPort}, null, '  '));
  for (let forwarderId in tunnel._listenerMap) {
    let listener = tunnel._listenerMap[forwarderId];
    if (listener.address === listenerAddress && listener.port === listenerPort ||
      listener.server.address().address === listenerAddress && listener.server.address().port === listenerPort) {
      listener.server.close();
      return;
    }
  }
}

function pipe_stream_to_tunnel(realStream, streamId, tunnel) {
  realStream
    .on('data', function (buf) {
      tunnel.cork();
      tunnel.write(`${streamId}\t:\t${buf.length.toString(16)}\n`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', function () {
      console.log('[Stream:' + streamId + '] ended');
      tunnel.write(`${streamId}\t!\n`);
    })
    .on('close', function () {
      console.log('[Stream:' + streamId + '] closed');
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId}\t-\n`);
    })
    .on('error', function (e) {
      console.log('[Stream:' + streamId + '] ' + e.message);
    });
}

if (!process) { //just to prevent JSLint error
  console.log({remoteAddress: "", remotePort: 8080, cork: Function, uncork: Function, alloc: Function});
}

main();
