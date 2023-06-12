import path, { delimiter } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

process.env.NODE_CONFIG_DIR = __dirname + '/config/'
    + delimiter
    + __dirname + '/defaultConfig/';

import { stringify } from '@tauri-apps/toml';
import humanDate from 'humanize-duration';
import configUncached from 'config-reloadable';
import express from 'express';
import fetch, { AbortError } from 'node-fetch';
import timeoutSignal from 'timeout-signal';
import fs from 'fs';
import { parse } from 'node-html-parser';
import { connect } from 'mqtt';

let config = configUncached();
let readings = {};

var defaultConfig = config.util.getConfigSources().find(s => s.name === __dirname + '/defaultConfig/default.toml').parsed;
var customConfig = config.util.diffDeep(defaultConfig, config.util.toObject(configUncached()));
console.log(customConfig);

const app = express();
const sensorQueryTimeout = 500;

app.get('/readings', (_, res) => {
    res.status(200).send(readings);
});

app.get('/discovery', (_, res) => {
    generateDiscoveryTopics().then(t => res.send(t));
});

app.get('/healthcheck', (_, res) => {
    const readingAge = Date.now() - lastReading;
    const response = {
        readingAge,
        toleratedAge: config.sensors.query_interval + sensorQueryTimeout,
        uptime: humanDate(process.uptime() * 1000, { maxDecimalPoints: 0 }),
    };
    response.sensors = getSensors().reduce((a, b) => {
        const status = (b.readings?.status ?? 500) == 200 ? "OK" : "N/A";
        return { ...a, [b.name]: { status: status } };
    }, {});

    res.status(200).send(response);
});


const publishReadings = async (reading) => {
    const c = getMQTTClient();
    for (const channel of reading.content.channels) {
        const type = channel.type.replace('_CONSUMPTION', '');
        //console.log(`publishing to '${config.mqtt.topic}/${readings.name}/${type}/state'`, channel);
        c.publish(`${config.mqtt.topic}/${reading.content.sensorId}/${type}/state`, JSON.stringify(channel));
    }
    c.publish(`${config.mqtt.topic}/${reading.content.sensorId}/state`, JSON.stringify({
        status: reading.status,
        last_update: reading.content.timestamp,
    }));
};

const getSensors = () => {
    const sensors = [];
    for (const sensorName in config.sensors) {
        const sensorConfig = config.sensors[sensorName];
        if (typeof sensorConfig !== 'object') { continue; }
        const sensor = { name: sensorName, config: sensorConfig };
        const sensorReadings = readings[sensorName];
        if (sensorReadings) {
            sensor.readings = sensorReadings;
        }
        sensors.push(sensor);
    }
    return sensors;
};

const generateDiscoveryTopics = async () => {
    const topics = {};

    for (const sensor of getSensors()) {
        const sensorReadings = sensor.readings;
        const dev = {
            name: sensorReadings.name,
            ids: sensorReadings.content.sensorId,
            model: sensorReadings.model,
            configuration_url: `http://${sensor.config.host}`,
            manufacturer: 'Generac',
            via_device: 'neurio-2-mqtt'
        };
        await fetch(`http://${sensor.config.host}`, { method: 'GET', signal: timeoutSignal(1500) })
            .then(res => res.text())
            .then(text => {
                const lines = parse(text).querySelector('.col-sm-6').innerHTML
                    .split('<br>')
                    .filter(l => l.includes('Version'))
                    .reduce((a, b) => {
                        var k_v = b.split(': ');
                        a[k_v[0]] = k_v[1];
                        return a;
                    }, {});
                dev.hw_version = lines['Hardware Version'];
                dev.sw_version = lines['Firmware Version'];
            })
            .catch(() => {});

        const id = sensorReadings.content.sensorId;
        const availability = {
            topic: `${config.mqtt.topic}/${id}/state`,
            value_template: "{{ 'online' if value_json.status == 200 else 'offline' }}",
        };

        const sensorTopics = sensorReadings.content.channels.reduce((a, b) => {
            const type = b.type.replace('_CONSUMPTION', '');

            a[`${config.homeassistant.discovery_topic}/sensor/neurio-${sensorReadings.content.sensorId}/${type}_eImp_Wh`] = {
                name: `${sensorReadings.name} ${type.replace('_', ' ')} Energy In`,
                unique_id: `${sensorReadings.content.sensorId}_${b.ch}_eImp_Wh`,
                state_topic: `${config.mqtt.topic}/${id}/${type}/state`,
                value_template: '{{ value_json.eImp_Ws // 3600 }}',
                unit_of_measurement: 'Wh',
                dev,
                availability,
                device_class: 'energy',
                state_class: 'total_increasing',
                expire_after: 95,
                icon: 'mdi:transmission-tower-export',
            };
            a[`${config.homeassistant.discovery_topic}/sensor/neurio-${sensorReadings.content.sensorId}/${type}_eExp_Wh`] = {
                name: `${sensorReadings.name} ${type.replace('_', ' ')} Energy Out`,
                unique_id: `${sensorReadings.content.sensorId}_${b.ch}_eExp_Wh`,
                state_topic: `${config.mqtt.topic}/${id}/${type}/state`,
                value_template: '{{ value_json.eExp_Ws // 3600 }}',
                unit_of_measurement: 'Wh',
                dev,
                availability,
                expire_after: 95,
                device_class: 'energy',
                state_class: 'total_increasing',
                icon: 'mdi:transmission-tower-import',
            };
            a[`${config.homeassistant.discovery_topic}/sensor/neurio-${sensorReadings.content.sensorId}/${type}_p_W`] = {
                name: `${sensorReadings.name} ${type.replace('_', ' ')} Power`,
                unique_id: `${sensorReadings.content.sensorId}_${b.ch}_p_W`,
                state_topic: `${config.mqtt.topic}/${id}/${type}/state`,
                value_template: '{{ value_json.p_W }}',
                unit_of_measurement: 'W',
                dev,
                availability,
                expire_after: 95,
                device_class: 'power',
                state_class: 'measurement',
            };
            a[`${config.homeassistant.discovery_topic}/sensor/neurio-${sensorReadings.content.sensorId}/${type}_v_V`] = {
                name: `${sensorReadings.name} ${type.replace('_', ' ')} Voltage`,
                unique_id: `${sensorReadings.content.sensorId}_${b.ch}_v_V`,
                state_topic: `${config.mqtt.topic}/${id}/${type}/state`,
                value_template: '{{ value_json.v_V }}',
                unit_of_measurement: 'V',
                dev,
                availability,
                expire_after: 95,
                device_class: 'voltage',
                state_class: 'measurement',
            };
            a[`${config.homeassistant.discovery_topic}/sensor/neurio-${sensorReadings.content.sensorId}/${type}_q_VAR`] = {
                name: `${sensorReadings.name} ${type.replace('_', ' ')} Reactive Power`,
                unique_id: `${sensorReadings.content.sensorId}_${b.ch}_q_VAR`,
                state_topic: `${config.mqtt.topic}/${id}/${type}/state`,
                value_template: '{{ value_json.q_VAR }}',
                unit_of_measurement: 'var',
                dev,
                availability,
                expire_after: 95,
                device_class: 'reactive_power',
                state_class: 'measurement',
                icon: 'mdi:flash-outline',
            };
            return a;
        }, {});
        for (const topic in sensorTopics) {
            topics[topic] = sensorTopics[topic];
        };
    }
    return topics;
};

let lastReading = 0;
const requestLoop = async () => {
    const sensorQueries = [];
    for (const sensorName in config.sensors) {
        const sensorConfig = config.sensors[sensorName];
        if (typeof sensorConfig !== 'object') { continue; }
        delete readings[sensorName];
        const sensorUrl = `http://${sensorConfig.host}/current-sample`;
        const currentSensor = { name: sensorName, model: sensorConfig.device_model };

        sensorQueries.push(fetch(sensorUrl, { method: "GET", signal: timeoutSignal(sensorQueryTimeout) })
            .then(res => res.json())
            .then(json => {
                readings[sensorName] = { status: 200, content: json, ...currentSensor };
                lastReading = Date.now();
            })
            .catch(e => {
                if (e instanceof AbortError) {
                    readings[sensorName] = { status: 504, content: `sensor API not reachable at ${sensorUrl}`, ...currentSensor };
                } else {
                    readings[sensorName] = { status: 500, content: e, ...currentSensor };
                }
            })
            .then(() => {
                return readings[sensorName];
            })
        );
    }

    Promise
        .all(sensorQueries)
        .then(readings => {
            for (const reading of readings) {
                if (reading.status === 200) {
                    publishReadings(reading);
                } else {
                    console.log(reading);
                }
            }
        })
        .catch(console.log);

    if (config.sensors.query_interval) {
        setTimeout(requestLoop, config.sensors.query_interval);
    }
};


let configChangedTs = Date.now();
fs.watch(__dirname + '/config', (type, filename) => {
    const lastModified = fs.statSync(__dirname + '/config/' + filename).mtimeMs;
    if (type !== 'change' || lastModified === configChangedTs) return;
    configChangedTs = lastModified;
    console.log(type, filename);
    config = configUncached.reloadConfigs();
});

const getMQTTClient = () => {
    const clientOptions = {
        username: config.mqtt.user ? config.mqtt.user : null,
        password: config.mqtt.password ? config.mqtt.password : null,
    };

    return connect(`${config.mqtt.proto}://${config.mqtt.host}:${config.mqtt.port}`, clientOptions);
}

app.listen(config.bridge.port, () => {
    console.log('listening on ' + config.bridge.port);
    requestLoop();
});

process.on('SIGUSR1', () => {
    generateDiscoveryTopics().then(t => {
        if (!t) { return; }
        console.log('Publishing homeassistant discovery topics to MQTT');

        const c = getMQTTClient();
        c.on('connect', () => {
            Object.keys(t).forEach(k => {
                console.log(`${k}/config`);
                c.publish(`${k}/config`, JSON.stringify(t[k]), { qos: 0, retain: true });
            })
         });
    });
});

const terminate = () => {
    console.log("bye");
    process.exit();
};

process
    .on('SIGINT', terminate)
    .on('SIGTERM', terminate);
