const express = require('express')

const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')
const recordController = require('./controllers/record.controller');


const FFmpeg = require('./ffmpeg');
const GStreamer = require('./gstreamer');
const PROCESS_NAME = process.env.PROCESS_NAME || 'GStreamer';

const {
    getPort,
    releasePort
} = require('./port');

const options = {
    key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
    cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
}

const httpsServer = https.createServer(options, app)
const io = require('socket.io')(httpsServer)

app.use(express.static(path.join(__dirname, '..', 'public')))

httpsServer.listen(config.listenPort, () => {
    console.log('listening https ' + config.listenPort)
})

// all mediasoup workers
let workers = []
let nextMediasoupWorkerIdx = 0

let roomList = new Map();

(async () => {
    await createWorkers()
})()

async function createWorkers() {
    let {
        numWorkers
    } = config.mediasoup

    for (let i = 0; i < numWorkers; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
        })

        worker.on('died', () => {
            console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
            setTimeout(() => process.exit(1), 2000);
        })
        workers.push(worker)

        // log worker resource usage
        /*setInterval(async () => {
            const usage = await worker.getResourceUsage();

            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }, 120000);*/
    }
}

io.on('connection', socket => {

    socket.on('createRoom', async ({
        room_id
    }, callback) => {
        if (roomList.has(room_id)) {
            callback('already exists')
        } else {
            console.log('---created room--- ', room_id)
            let worker = await getMediasoupWorker()
            roomList.set(room_id, new Room(room_id, worker, io))
            callback(room_id)
        }
    })

    socket.on('join', ({
        room_id,
        name
    }, cb) => {

        console.log('---user joined--- \"' + room_id + '\": ' + name)
        if (!roomList.has(room_id)) {
            return cb({
                error: 'room does not exist'
            })
        }
        roomList.get(room_id).addPeer(new Peer(socket.id, name))
        socket.room_id = room_id

        cb(roomList.get(room_id).toJson())
    })

    socket.on('start-record', (data, callback) => {
        let room = roomList.get(data.room_id);
        let peer = room.getPeers().get(data.peer_id);
        callback(peer);

        startRecord(room, peer);
    })

    socket.on('stop-record', async (data, callback) => {
        let room = roomList.get(data.room_id);
        let peer = room.getPeers().get(data.peer_id);
        
        await stopRecord(peer);
        
        callback(peer);
    });

    socket.on('getProducers', () => {
        console.log(`---get producers--- name:${roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        // send all the current producer to newly joined member
        if (!roomList.has(socket.room_id)) return
        let producerList = roomList.get(socket.room_id).getProducerListForPeer(socket.id)

        socket.emit('newProducers', producerList)
    })

    socket.on('getRouterRtpCapabilities', (_, callback) => {
        console.log(`---get RouterRtpCapabilities--- name: ${roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        try {
            callback(roomList.get(socket.room_id).getRtpCapabilities());
        } catch (e) {
            callback({
                error: e.message
            })
        }

    });

    socket.on('createWebRtcTransport', async (_, callback) => {
        console.log(`---create webrtc transport--- name: ${roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        try {
            const {
                params
            } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id);

            callback(params);
        } catch (err) {
            console.error(err);
            callback({
                error: err.message
            });
        }
    });

    socket.on('connectTransport', async ({
        transport_id,
        dtlsParameters
    }, callback) => {
        console.log(`---connect transport--- name: ${roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        if (!roomList.has(socket.room_id)) return
        await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

        callback('success')
    })

    socket.on('produce', async ({
        kind,
        rtpParameters,
        producerTransportId
    }, callback) => {

        if (!roomList.has(socket.room_id)) {
            return callback({
                error: 'not is a room'
            })
        }

        let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)
        console.log(`---produce--- type: ${kind} name: ${roomList.get(socket.room_id).getPeers().get(socket.id).name} id: ${producer_id}`)
        callback({
            producer_id
        })

        let room = roomList.get(socket.room_id)
        let peer = roomList.get(socket.room_id).getPeers().get(socket.id)
        
        startRecord(room, peer);
    })

    socket.on('consume', async ({
        consumerTransportId,
        producerId,
        rtpCapabilities
    }, callback) => {
        //TODO null handling
        let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

        console.log(`---consuming--- name: ${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name} prod_id:${producerId} consumer_id:${params.id}`)
        callback(params)
    })

    socket.on('resume', async (data, callback) => {

        await consumer.resume();
        callback();
    });

    socket.on('getMyRoomInfo', (_, cb) => {
        cb(roomList.get(socket.room_id).toJson())
    })

    socket.on('disconnect', async () => {
        console.log(`---disconnect--- name: ${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        if (!socket.room_id) return;

       
        let peer = roomList.get(socket.room_id).getPeers().get(socket.id);
        
        await stopRecord(peer, socket.room_id);

        roomList.get(socket.room_id).removePeer(socket.id);
    })

    socket.on('producerClosed', async ({
        producer_id
    }) => {
        console.log(`---producer close--- name: ${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        
        let peer = roomList.get(socket.room_id).getPeers().get(socket.id);
        
        await stopRecord(peer, socket.room_id);

        roomList.get(socket.room_id).closeProducer(socket.id, producer_id);
    })

    socket.on('exitRoom', async (_, callback) => {
        console.log(`---exit room--- name: ${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`)
        if (!roomList.has(socket.room_id)) {
            callback({
                error: 'not currently in a room'
            })
            return
        }
        // close transports
        await roomList.get(socket.room_id).removePeer(socket.id)
        if (roomList.get(socket.room_id).getPeers().size === 0) {
            roomList.delete(socket.room_id)
        }

        socket.room_id = null


        callback('successfully exited room')
    })
})

function room() {
    return Object.values(roomList).map(r => {
        return {
            router: r.router.id,
            peers: Object.values(r.peers).map(p => {
                return {
                    name: p.name,
                }
            }),
            id: r.id
        }
    })
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
    const worker = workers[nextMediasoupWorkerIdx];

    if (++nextMediasoupWorkerIdx === workers.length)
        nextMediasoupWorkerIdx = 0;

    return worker;
}


const publishProducerRtpStream = async (room, peer, producer) => {
    console.log('publishProducerRtpStream()');

    // Create the mediasoup RTP Transport used to send media to the GStreamer process
    const rtpTransportConfig = config.mediasoup.plainRtpTransport;

    // If the process is set to GStreamer set rtcpMux to false
    if (PROCESS_NAME === 'GStreamer') {
        rtpTransportConfig.rtcpMux = false;
    }

    const rtpTransport = await room.router.createPlainRtpTransport(rtpTransportConfig);

    // Set the receiver RTP ports
    const remoteRtpPort = await getPort();
    peer.remotePorts.push(remoteRtpPort);

    let remoteRtcpPort;
    // If rtpTransport rtcpMux is false also set the receiver RTCP ports
    if (!rtpTransportConfig.rtcpMux) {
        remoteRtcpPort = await getPort();
        peer.remotePorts.push(remoteRtcpPort);
    }


    // Connect the mediasoup RTP transport to the ports used by GStreamer
    await rtpTransport.connect({
        ip: '127.0.0.1',
        port: remoteRtpPort,
        rtcpPort: remoteRtcpPort
    });

    peer.addTransport(rtpTransport);

    const codecs = [];
    // Codec passed to the RTP Consumer must match the codec in the Mediasoup router rtpCapabilities
    const routerCodec = room.getRtpCapabilities().codecs.find(
        codec => codec.kind === producer.kind
    );
    codecs.push(routerCodec);

    const rtpCapabilities = {
        codecs,
        rtcpFeedback: []
    };

    // Start the consumer paused
    // Once the gstreamer process is ready to consume resume and send a keyframe
    const rtpConsumer = await rtpTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true
    });

    // peer.consumers.push(rtpConsumer);
    peer.consumers.set(rtpConsumer.id, rtpConsumer)

    return {
        remoteRtpPort,
        remoteRtcpPort,
        localRtcpPort: rtpTransport.rtcpTuple ? rtpTransport.rtcpTuple.localPort : undefined,
        rtpCapabilities,
        rtpParameters: rtpConsumer.rtpParameters
    };
};

const startRecord = async (room, peer) => {
    let recordInfo = {};

    for (const producerKey of peer.producers.keys()) {
        const producer = peer.producers.get(producerKey);
        recordInfo[producer.kind] = await publishProducerRtpStream(room, peer, producer);
    }

    recordInfo.fileName = Date.now().toString();
    // recordInfo.fileName = room.id;

    peer.process = getProcess(recordInfo);

    setTimeout(async () => {
        for (const consumerKey of peer.consumers.keys()) {
            // Sometimes the consumer gets resumed before the GStreamer process has fully started
            // so wait a couple of seconds
            const consumer = peer.consumers.get(consumerKey);
            await consumer.resume();
        }

    }, 1000);
}

const stopRecord = async (peer, room_id) => {
    // console.log(peer)    
    if (peer && peer.process) {
        console.log(peer)
        console.log(room_id)
        const starttime = peer.process._rtpParameters.fileName;
        const filename = starttime + '.webm';
        recordController.addNewRecord(peer.name, room_id, filename, starttime);

        peer.process.kill();
        peer.process = undefined;
    }

    for (const remotePort of peer.remotePorts) {
        releasePort(remotePort);
    }
}

const getProcess = (recordInfo) => {
    switch (PROCESS_NAME) {
        case 'GStreamer':
            return new GStreamer(recordInfo);
        case 'FFmpeg':
        default:
            return new FFmpeg(recordInfo);
    }
};


app.get('/allrecords', function(req, res) {
    // let records = [];
    // fs.readdir('./public/files', (err, files) => {
    //     files.forEach(file => {
    //         console.log(file)
    //         records.push(
    //             {'record': '/files/' + file, 'name': file}
    //         )
    //     })
    //     res.json(records);
    // })

    recordController.getAllRecords().then(data => res.json(data));
})


const db = require('./config/db.config.js');

// force: true will drop the table if it already exists
db.sequelize.sync({force: true}).then(() => {
    console.log('Drop and Resync with { force: false }');
}); 

// app.get('/mergeall', function(req, res) {
//     recordController.mergeAll("123").then(data => res.json(data));
// })