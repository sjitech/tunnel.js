#!/usr/bin/env node
'use strict';
const net = require('net'), util = require('util'), readline = require('readline'), dns = require('dns');
console.log = console.error;

function show_usage() {
  console.log('Create a tunnel for port forwarding/reversing.');
  console.log('Usage of Tunnel Server:');
  console.log('  tunnel.js listen [localAddress:]port');
  console.log('Usage of Tunnel Client:');
  console.log('  tunnel.js connect [host:]port [-source [localAddress:]port] ...');
  show_usage_tunnel_instruction();
  process.exit(1);
}

function show_usage_tunnel_instruction() {
  console.log('The Tunnel Client will read instructions from arguments and standard input.');
  console.log('  forward [localAddress:]port [destHOST:]PORT');
  console.log('  reverse [localADDRESS:]PORT [destHost:]port');
  console.log('  end-forward [localAddress:]port');
  console.log('  end-reverse [localADDRESS:]PORT');
  console.log('Notes:');
  console.log('  Uppercase args just means they are in sense of the tunnel server.');
  console.log('  IPv6 address must be wrapped by square brackets, e.g. [::1]:8080');
}

let isTunnelServer;

function main(args) {
  switch (args.shift()) {
    case 'listen': {
      if (args.length !== 1) break;
      let [localAddress, localPort] = split_host_port(args.shift());
      if (localPort != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);
      console.log('Using parameters ' + JSON.stringify({localAddress, localPort}, null, '    '));

      isTunnelServer = true;
      net.createServer(tunnel => {
        const tag = `[Tunnel~[${tunnel.remoteAddress}]:${tunnel.remotePort}] `;
        console.log(`${tag}Connected from [${tunnel.remoteAddress}]:${tunnel.remotePort}`);

        init_mux_tunnel(tunnel, tag);

      }).listen({host: localAddress, port: localPort}, function () {
        console.log(`Listening at [${this.address().address}]:${this.address().port}`);
      }).on('error', e => console.log('' + e));
      return;
    }
    case 'connect': {
      if (!args.length) break;
      let [host, port] = split_host_port(args.shift());
      if (!port) break;
      if (port != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);

      let localAddress, localPort;
      if (args[0] === '-source') {
        args.shift();
        if (!args.length) break;
        [localAddress, localPort] = split_host_port(args.shift());
        if (localPort != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);
      }
      console.log('Using parameters ' + JSON.stringify({host, port, localAddress, localPort}, null, '    '));

      resolve_address(localAddress, localAddress => {
        const tag = '[Tunnel] ';
        let tunnel = net.connect({host, port, localAddress, localPort}, () =>
          console.log(`${tag}Connected to [${tunnel.remoteAddress}]:${tunnel.remotePort} source [${tunnel.localAddress}]:${tunnel.localPort}`)
        );

        init_mux_tunnel(tunnel, tag);

        while (args.length && run_tunnel_instruction(tunnel, args)) {
        }
        readline.createInterface({input: process.stdin}).on('line', line => {
          run_tunnel_instruction(tunnel, line.trim().split(/\s+/));
        });
      });
      return;
    }
  }
  show_usage();
}

function run_tunnel_instruction(tunnel, args) {
  if (!args.length) return false;
  let instruction = args.shift();
  switch (instruction) {
    case 'forward':
    case 'reverse': {
      if (args.length < 2) break;
      let [localAddress,localPort] = split_host_port(args.shift());
      if (localPort != split_host_port.port_s) return (console.log('invalid port: ' + split_host_port.port_s), false);
      let [destHost,destPort] = split_host_port(args.shift());
      if (!destPort) break;
      if (destPort != split_host_port.port_s) return (console.log('invalid port: ' + split_host_port.port_s), false);

      if (instruction === 'forward') {
        create_forwarder_listener(tunnel, localAddress, localPort, destHost, destPort);
      } else {
        console.log('Request peer to create forwarder ' + JSON.stringify(
            {localAddress, localPort, destHost, destPort}, null, '    '));
        tunnel.write(`\tforward\t${localAddress}\t${localPort}\t${destHost}\t${destPort}\n`);
      }
      return true;
    }
    case 'end-forward':
    case 'end-reverse': {
      if (!args.length) break;
      let [localAddress,localPort] = split_host_port(args.shift());
      if (localPort != split_host_port.port_s) return (console.log('invalid port: ' + split_host_port.port_s), false);

      if (instruction === 'end-forward') {
        end_forwarder_listener(tunnel, localAddress, localPort);
      } else {
        console.log('Request peer to end forwarder ' + JSON.stringify({localAddress, localPort}, null, '    '));
        tunnel.write(`\tend-forward\t${localAddress}\t${localPort}\n`);
      }
      return true;
    }
    case '?':
    case 'help':
      show_usage_tunnel_instruction();
      return true;
  }
  console.log('Invalid tunnel instruction. To see help, input ?');
  return false;
}

function init_mux_tunnel(tunnel, tunnelTag) {
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

          console.log(tunnelTag + event_s);
          const args = event_s.split('\t');

          curRealStream = handle_tunnel_event(tunnel, args);
        }
        else {
          eventBuf = Buffer.concat([eventBuf, buf]);
        }
      }
    }
  }).on('close', () => {
    console.log(tunnelTag + 'closed');

    for (let streamId in tunnel._streamMap) {
      tunnel._streamMap[streamId].destroy();
      tunnel._streamMap = {};
    }
    for (let forwarderId in tunnel._listenerMap) {
      tunnel._listenerMap[forwarderId].server.close();
      tunnel._listenerMap = {};
    }
    tunnel._targetMap = {};

    if (!isTunnelServer) {
      process.exit(0);
    }
  }).on('end', () => console.log(tunnelTag + 'EOF'))
    .on('error', e => console.log(tunnelTag + e));
}

function handle_tunnel_event(tunnel, args) {
  const streamId = args.shift();
  const eventName = args.shift();

  if (streamId) {
    const forwarderId = streamId.split('#')[0];

    if (streamId === forwarderId) { //listener events from peer
      switch (eventName) {
        case '+': //on listening
          tunnel._targetMap[forwarderId] = {host: args.shift(), port: args.shift() | 0};
          return;
        case '-': //on close
          delete tunnel._targetMap[forwarderId];
          return;
      }
    }
    else { //stream events from peer
      let realStream = tunnel._streamMap[streamId];
      switch (eventName) {
        case '+': {//on connect
          let target = tunnel._targetMap[forwarderId];
          if (target) {
            console.log(`[Stream:${streamId}] Connect to [${target.host}]:${target.port}`);
            realStream = net.connect(target, () =>
              console.log(`[Stream:${streamId}] Connected to [${realStream.remoteAddress}]:${realStream.remotePort} source [${realStream.localAddress}]:${realStream.localPort}`)
            );
            tunnel._streamMap[streamId] = realStream;
            pipe_stream_to_tunnel(tunnel, realStream, streamId);
          }
          return;
        }
        case ':': { //on data
          let len = parseInt(args.shift(), 16);
          if (realStream && len > 0) {
            realStream._restLenOfDataToRead = len;
            return realStream;
          }
          return;
        }
        case '!': //on end
          if (realStream) {
            realStream.end();
          }
          return;
        case '-': //on close
          if (realStream) {
            realStream.destroy();
            delete tunnel._streamMap[streamId];
          }
          return;
      }
    }
  } else { //internal commands
    switch (eventName) {
      case 'forward':
        create_forwarder_listener(tunnel, args.shift(), args.shift() | 0, args.shift(), args.shift() | 0);
        return;
      case 'end-forward':
        end_forwarder_listener(tunnel, args.shift(), args.shift() | 0);
        return;
    }
  }

  console.log('invalid event');
  tunnel.destroy();
}

let lastForwarderId = 0;

function create_forwarder_listener(tunnel, localAddress, localPort, destHost, destPort) {
  console.log((isTunnelServer ? `[Tunnel~[${tunnel.remoteAddress}]:${tunnel.remotePort}] ` : '' ) + 'Create port forwarder ' +
    JSON.stringify({localAddress, localPort, destHost, destPort}, null, '    '));

  const forwarderId = (isTunnelServer ? 'F' : 'f') + (++lastForwarderId).toString(16);
  let lastStreamId = 0;

  net.createServer({allowHalfOpen: true}, realStream => {
    const streamId = forwarderId + '#' + (++lastStreamId).toString(16);
    console.log(`[Stream:${streamId}] Connected from [${realStream.remoteAddress}]:${realStream.remotePort}`);
    tunnel._streamMap[streamId] = realStream;

    tunnel.write(`${streamId}\t+\n`);

    pipe_stream_to_tunnel(tunnel, realStream, streamId);

  }).listen({host: localAddress, port: localPort}, function () {
    console.log(`[Forwarder:${forwarderId}] Listening at [${this.address().address}]:${this.address().port}`);
    tunnel._listenerMap[forwarderId] = {server: this, localAddress, localPort};
    tunnel.write(`${forwarderId}\t+\t${destHost}\t${destPort}\n`);

  }).on('close', () => {
    console.log(`[Forwarder:${forwarderId}] Closed`);
    delete tunnel._listenerMap[forwarderId];
    tunnel.write(`${forwarderId}\t-\n`);
  }).on('error', function (e) {
    console.log(`[Forwarder:${forwarderId}] ${e}`);
    this.close();
  });
}

function end_forwarder_listener(tunnel, localAddress, localPort) {
  console.log('End port forwarder ' + JSON.stringify({localAddress, localPort}, null, '    '));

  for (let forwarderId in tunnel._listenerMap) {
    let listener = tunnel._listenerMap[forwarderId];
    if ((!localAddress || listener.localAddress === localAddress || listener.server.address().address === localAddress)
      && (!localPort || listener.localPort === localPort || listener.server.address().port === localPort)) {
      listener.server.close();
      return;
    }
  }
}

function pipe_stream_to_tunnel(tunnel, realStream, streamId) {
  realStream
    .on('data', buf => {
      tunnel.cork();
      tunnel.write(`${streamId}\t:\t${buf.length.toString(16)}\n`);
      tunnel.write(buf);
      tunnel.uncork();
    })
    .on('end', () => {
      console.log(`[Stream:${streamId}] EOF`);
      tunnel.write(`${streamId}\t!\n`);
    })
    .on('close', () => {
      console.log(`[Stream:${streamId}] closed`);
      delete tunnel._streamMap[streamId];
      tunnel.write(`${streamId}\t-\n`);
    })
    .on('error', e => console.log(`[Stream:${streamId}] ${e}`))
    .once('data', buf => console.log(`[Stream:${streamId}] first data`))
}

function resolve_address(host, on_complete) {
  if (!host || net.isIP(host)) return on_complete(host);
  dns.lookup(host, (e, address) => {
    if (e) console.log('failed to get IP. ' + e);
    on_complete(address);
  });
}

function split_host_port(combo) {
  let m = combo.match(/^(\d+)$|^\[([^\]]*)\]:?(.*)$|^([^:]*):([^:]*)$|^(.*)$/);
  return [(m[2] || m[4] || m[6] || '').replace(/^\*$/, ''), (split_host_port.port_s = (m[1] || m[3] || m[5] || '')) & 0xffff];
}

main(process.argv.slice(2));  //script args is start from the 3rd.
