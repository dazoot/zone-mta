'use strict';

// NB! This script is ran as a separate process, so no direct access to the queue, no data
// sharing with other part of the code etc.

const SendingZone = require('./lib/sending-zone').SendingZone;
const config = require('config');
const log = require('npmlog');
const Sender = require('./lib/sender');
const crypto = require('crypto');
const QueueClient = require('./lib/transport/client');
const queueClient = new QueueClient(config.queueServer);
const SRS = require('srs.js');

const srsRewriter = new SRS({
    secret: config.srs.secret
});

const senders = new Set();

let cmdId = 0;
let responseHandlers = new Map();

let closing = false;
let zone;

// Read command line arguments
let currentZone = (process.argv[2] || '').toString().trim().toLowerCase();
let clientId = (process.argv[3] || '').toString().trim().toLowerCase() || crypto.randomBytes(10).toString('hex');

// Find and setup correct Sending Zone
Object.keys(config.zones || {}).find(zoneName => {
    let zoneData = config.zones[zoneName];
    if (zoneName === currentZone) {
        zone = new SendingZone(zoneName, zoneData, false);
        return true;
    }
    return false;
});

if (!zone) {
    log.error('Sender/' + process.pid, 'Unknown Zone %s', currentZone);
    return process.exit(5);
}

log.level = 'logLevel' in zone ? zone.logLevel : config.log.level;
log.info('Sender/' + zone.name + '/' + process.pid, 'Starting sending for %s', zone.name);

process.title = 'zone-mta: sender process [' + currentZone + ']';

function sendCommand(cmd, callback) {
    let id = ++cmdId;
    let data = {
        req: id
    };

    if (typeof cmd === 'string') {
        cmd = {
            cmd
        };
    }

    Object.keys(cmd).forEach(key => data[key] = cmd[key]);
    console.log(data);
    responseHandlers.set(id, callback);
    queueClient.send(data);
}

queueClient.connect(err => {
    if (err) {
        log.error('Sender/' + zone.name + '/' + process.pid, 'Could not connect to Queue server');
        log.error('Sender/' + zone.name + '/' + process.pid, err.message);
        process.exit(1);
    }

    queueClient.on('close', () => {
        if (!closing) {
            log.error('Sender/' + zone.name + '/' + process.pid, 'Connection to Queue server closed unexpectedly');
            process.exit(1);
        }
    });

    queueClient.onData = (data, next) => {
        let callback;
        if (responseHandlers.has(data.req)) {
            console.log('running response cb %s', data.req);
            callback = responseHandlers.get(data.req);
            responseHandlers.delete(data.req);
            setImmediate(() => callback(data.error ? data.error : null, !data.error && data.response));
        }
        next();
    };

    // Notify the server about the details of this client
    queueClient.send({
        cmd: 'HELLO',
        zone: zone.name,
        id: clientId
    });

    // start sending instances
    for (let i = 0; i < zone.connections; i++) {
        // use artificial delay to lower the chance of races
        setTimeout(() => {
            let sender = new Sender(clientId, i + 1, zone, sendCommand, srsRewriter);
            senders.add(sender);
            sender.on('error', () => {
                closing = true;
                senders.forEach(sender => {
                    sender.removeAllListeners('error');
                    sender.close();
                });
                senders.clear();
            });
        }, Math.random() * 1500);
    }
    setInterval(() => {
        log.info('TIME', new Date().toISOString());
        senders.forEach(sender => sender.getTimers());
    }, 5 * 60 * 1000).unref();
});
