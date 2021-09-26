const os = require('os')

module.exports = {
    listenIp: '0.0.0.0',
    listenPort: 3016,
    sslCrt: '../ssl/cert.pem',
    sslKey: '../ssl/key.pem',
    // sslCrt: '../ssl/rootCA.pem',
    // sslKey: '../ssl/rootCA-key.pem',
    
    mediasoup: {
      // Worker settings
      numWorkers : Object.keys(os.cpus()).length,
      worker: {
        rtcMinPort: 10000,
        rtcMaxPort: 10100,
        logLevel: 'warn',
        logTags: [
          'info',
          'ice',
          'dtls',
          'rtp',
          'srtp',
          'rtcp',
          // 'rtx',
          // 'bwe',
          // 'score',
          // 'simulcast',
          // 'svc'
        ],
      },
      // Router settings
      router: {
        mediaCodecs:
          [
            {
              kind: 'audio',
              mimeType: 'audio/opus',
              clockRate: 48000,
              channels: 2
            },
            {
              kind: 'video',
              mimeType: 'video/VP8',
              clockRate: 90000,
              parameters:
                {
                  'x-google-start-bitrate': 1000
                }
            },
          ]
      },
    // WebRtcTransport settings
    webRtcTransport: {
        listenIps: [
          {
            ip: '0.0.0.0',      
            announcedIp:'127.0.0.1' // replace by public IP address
          }
        ],
        maxIncomingBitrate: 1500000,
        initialAvailableOutgoingBitrate: 1000000
    },

    plainRtpTransport: {
      listenIp: { ip: '0.0.0.0', announcedIp: '0.0.0.0' }, // TODO: Change announcedIp to your external IP or domain name
      rtcpMux: false,
      comedia: false
    },

    }
};
  
