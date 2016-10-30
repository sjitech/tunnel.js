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

const EVENT_STREAM_ON_CREATE = '+';
const EVENT_STREAM_ON_CLOSE = '-';
const EVENT_STREAM_ON_DATA = ':';
const EVENT_STREAM_ON_END = '!';
const EVENT_FORWARDER_LISTENER_ON_CREATE= 'L+';
const EVENT_FORWARDER_LISTENER_ON_CLOSE = 'L-';
const EVENT_REQ_REVERSE= '';

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
            tunnel.write(`,${v.fromAddress},${v.fromPort},${v.toAddress},${v.toPort}\0`);
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
  tunnel.forwarderIdMax = 0;
  tunnel._streamIdMax = 0;
  tunnel._streamMap = {/*key is streamId*/};
  tunnel._targetMap = {/*key is forwarderId*/};
  tunnel._listenerMap = {/*key is forwarderId*/};
  var eventBuf = Buffer.alloc(0);
  var currentStream;

  tunnel.on('data', buf => {
    var restBuf = buf;
    while (restBuf && restBuf.length > 0) {
      buf = restBuf;
      restBuf = null;

      if (currentStream) {
        //pipe tunnel incoming data to real stream
        currentStream.write(buf.slice(0, currentStream._restLenOfDataToRead));

        if (buf.length >= currentStream._restLenOfDataToRead) {
          restBuf = buf.slice(currentStream._restLenOfDataToRead);
          currentStream._restLenOfDataToRead = 0;
          currentStream = null;
        } else {
          currentStream._restLenOfDataToRead -= buf.length;
        }
      } else {
        var pos = buf.indexOf(0);
        if (pos >= 0) {
          console.log('[tunnel] ' + Buffer.concat([eventBuf, buf.slice(0, pos + 1)]).toString());
          var event;
          try {
            event = JSON.parse(Buffer.concat([eventBuf, buf.slice(0, pos + 1)]).toString());
          } catch (e) {
            console.log('failed to parse event. ' + e.message);
            tunnel.destroy();
            break;
          }
          if (buf.length > pos + 1) {
            restBuf = buf.slice(pos + 1);
          }
          eventBuf = eventBuf.slice(0, 0);
          var stream;

          switch (event[0]) {
            case EVENT_FORWARDER_LISTENER_ON_CREATE:
              tunnel.forwarderMap[event[1].forwarderId] = {
                toAddress: event[1].toAddress,
                toPort: event[1].toPort
              };
              break;
            case EVENT_FORWARDER_LISTENER_ON_CLOSE:
              delete tunnel.forwarderMap[event[1].forwarderId];
              break;
            case EVENT_REQ_REVERSE:
              create_forwarder(tunnel, event[1].fromAddress, event[1].fromPort, event[1].toAddress, event[1].toPort);
              break;
            case EVENT_STREAM_ON_CREATE:
              tunnel.streamMap[event[1]] = stream = {
                realStream: net.connect(tunnel.forwarderMap[event[2]])
              };
              pipe_stream_to_tunnel(stream.realStream, event[1], tunnel);
              break;
            default:
              stream = tunnel.streamMap[event.streamId];
              if (!stream) {
                break;
              }
              switch (event[0]) {
                case 'data':
                  stream.length = event.length;
                  currentStream = stream;
                  break;
                case 'end':
                  stream.realStream.end();
                  break;
                case 'close':
                  stream.realStream.destroy();
                  delete tunnel.streamMap[event.streamId];
                  break;
                default:
                  console.log('wrong event name ' + event[0]);
                  tunnel.destroy();
              }
          }
        } else {
          eventBuf = Buffer.concat([eventBuf, buf]);
        }
      }
    }
  }).on('close', () => {
    if(side == TUNNEL_SERVER) {
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
  var forwarderId = tunnel._side + '/' + (++tunnel.forwarderIdMax).toString(16);
  net.createServer({allowHalfOpen: true}, realStream => {
    var streamId = forwarderId+'#'+(++tunnel.streamIdMax).toString(16);
    
    tunnel.write(`${streamId},+\0`);

    tunnel.streamMap[streamId] = realStream;

    pipe_stream_to_tunnel(realStream, streamId, tunnel);

  }).listen({host: fromAddress, port: fromPort}, function () {
    console.log('[Forwarder] Listening TCP ' + this.address().port + ' of ' + this.address().address);
    tunnel._listenerMap[forwarderId] = this;
    tunnel.write(`${forwarderId},${fromAddress},${fromPort},${toAddress},${toPort}\0`);
  }).on('error', e => {
    console.log(e.message);
  }).on('close', () => {
    delete tunnel._listenerMap[forwarderId];
    tunnel.write(`${forwarderId},-\0`);
  });
}

function pipe_stream_to_tunnel(realStream, streamId, tunnel) {
  realStream
    .on('data', buf => {
      tunnel.cork();
      tunnel.write(`${streamId},${buf.length}\0`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', () => {
      tunnel.write(`${streamId},!\0`);
    })
    .on('close', () => {
      delete tunnel.streamMap[streamId];
      tunnel.write(`${streamId},-\0`);
    })
    .on('error', e => {
      console.log(e.message);
    });
}

main();
