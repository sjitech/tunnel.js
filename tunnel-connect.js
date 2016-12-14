#!/usr/bin/env node
'use strict';
const net = require('net'), dns = require('dns'), readline = require('readline'), util = require('util');
console.log = console.error;
const tunnelUtil = require('./tunnel.js');

function show_usage() {
  console.log('Create a tunnel for port forwarding/reversing.');
  console.log('Usage:');
  console.log('  tunnel.js connect [host:]port [-source [localAddress:]port] ...');
  console.log('Note:');
  console.log('  IPv6 address must be wrapped by square brackets, e.g. [::1]:8080');
  show_usage_tunnel_instruction();
  process.exit(1);
}

function show_usage_tunnel_instruction() {
  console.log('You can input instructions from arguments or standard input:');
  console.log('  forward [localAddress:]port [destHOST:]PORT');
  console.log('  reverse [localADDRESS:]PORT [destHost:]port');
  console.log('You can input instructions from arguments or standard input:');
  console.log('  end-forward [[localAddress:]port]');
  console.log('  end-reverse [[localADDRESS:]PORT]');
  console.log('  list');
  console.log('Notes:');
  console.log('  Uppercase args just means they are in sense of the tunnel server.');
  console.log('  IPv6 address must be wrapped by square brackets, e.g. [::1]:8080');
}

function main(args) {
  if (!args.length || args[0] === '--help') return show_usage();
  let [host, port] = split_host_port(args.shift());
  if (!port) return show_usage();
  if (port != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);

  let localAddress, localPort;
  if (args[0] === '-source') {
    args.shift();
    if (!args.length) return show_usage();
    [localAddress, localPort] = split_host_port(args.shift());
    if (localPort != split_host_port.port_s) return console.log('invalid port: ' + split_host_port.port_s);
  }
  console.log('Using parameters ' + JSON.stringify({host, port, localAddress, localPort}, null, '    '));

  resolve_address(localAddress, localAddress => {
    let tunnel = net.connect({host, port, localAddress, localPort}, () =>
      console.log(`Connected to [${tunnel.remoteAddress}]:${tunnel.remotePort} source [${tunnel.localAddress}]:${tunnel.localPort}`)
    );
    tunnel.on('close', () => process.exit(0));

    tunnelUtil.init_mux_tunnel(tunnel, '', /*isTunnelServer:*/false);

    while (args.length && run_tunnel_instruction(tunnel, args)) {
    }
    readline.createInterface({input: process.stdin}).on('line', line => {
      run_tunnel_instruction(tunnel, line.trim().split(/\s+/));
    });
  });
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
        tunnelUtil.create_forwarder_listener(tunnel, localAddress, localPort, destHost, destPort);
      } else {
        console.log('Request peer to create forwarder ' + JSON.stringify(
            {localAddress, localPort, destHost, destPort}, null, '    '));
        tunnel.write(`\tforward\t${localAddress}\t${localPort}\t${destHost}\t${destPort}\n`);
      }
      return true;
    }
    case 'end-forward':
    case 'end-reverse': {
      let [localAddress,localPort] = split_host_port(args.shift() || '');
      if (localPort != split_host_port.port_s) return (console.log('invalid port: ' + split_host_port.port_s), false);

      if (instruction === 'end-forward') {
        tunnelUtil.end_forwarder_listener(tunnel, localAddress, localPort);
      } else {
        console.log('Request peer to end forwarder ' + JSON.stringify({localAddress, localPort}, null, '    '));
        tunnel.write(`\tend-forward\t${localAddress}\t${localPort}\n`);
      }
      return true;
    }
    case 'list': {
      for (let forwarderId in tunnel._listenerMap) {
        console.log('Forwarder: ' + util.inspect(tunnel._listenerMap[forwarderId].info, {breakLength: Infinity}))
      }
      for (let forwarderId in tunnel._targetMap) {
        console.log('Reverser:  ' + util.inspect(tunnel._targetMap[forwarderId].info, {breakLength: Infinity}))
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
