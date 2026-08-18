#!/usr/bin/env node
/**
 * make-certs.js — generate a self-signed certificate for LAN testing.
 *
 * Browsers only hand out the microphone on a secure origin. localhost counts
 * as secure; the 192.168.x.x address a phone has to use does not. Without
 * HTTPS the record button simply fails on every phone on the network.
 *
 * The generated certificate lists every current LAN IP in subjectAltName, so
 * the phone can reach the laptop by address. It is self-signed, so the phone
 * will still show a warning once — accept it, and the microphone works.
 *
 * For a warning-free certificate, use mkcert instead:
 *   brew install mkcert && mkcert -install
 *   mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 192.168.1.42
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const certDir = path.join(__dirname, '..', 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  console.error('openssl was not found on PATH.');
  console.error('Install it, or generate certs/key.pem and certs/cert.pem another way.');
  process.exit(1);
}

fs.mkdirSync(certDir, { recursive: true });

const ips = lanAddresses();
const altNames = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(ip => `IP:${ip}`)].join(',');

const confPath = path.join(certDir, 'openssl.cnf');
fs.writeFileSync(confPath, `
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = solaris.local

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${altNames}
`.trim() + '\n');

execFileSync('openssl', [
  'req', '-x509', '-nodes',
  '-newkey', 'rsa:2048',
  '-days', '365',
  '-keyout', keyPath,
  '-out', certPath,
  '-config', confPath,
], { stdio: 'inherit' });

fs.unlinkSync(confPath);

console.log('');
console.log('Certificate written to certs/');
console.log('Valid for:');
console.log('  https://localhost:3001');
for (const ip of ips) console.log(`  https://${ip}:3001   <- open this one on the phone`);
console.log('');
console.log('The phone will warn once that the certificate is not trusted.');
console.log('Accept it; the microphone will then be allowed.');
