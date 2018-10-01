/**
 * Copyright 2017 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
"use strict";
const util = require('util');
const path = require('path');
const fs = require('fs');

let tx_id = null;
const config = require('../config.json');
const helper = require('./helper.js');
const logger = helper.getLogger('Join-Channel');
const ORGS = helper.ORGS;
const CONFIG_DIR = helper.CONFIG_DIR;
const allEventhubs = [];

// on process exit, always disconnect the event hub
const closeConnections = function(isSuccess) {
    if (isSuccess) {
        logger.debug('\n============ Join Channel is SUCCESS ============\n');
    } else {
        logger.debug('\n!!!!!!!! ERROR: Join Channel FAILED !!!!!!!!\n');
    }
    logger.debug('');
    for (const key in allEventhubs) {
        const eventhub = allEventhubs[key];
        if (eventhub && eventhub.isconnected()) {
            //logger.debug('Disconnecting the event hub');
            eventhub.disconnect();
        }
    }
};

//
// Attempt to send a request to the orderer with the sendCreateChain method
// Should be called by admin
//
const joinChannel = function(peers, channelID, username, org) {
	//logger.debug('\n============ Join Channel ============\n')
	logger.info(util.format('Calling peers in organization "%s" to join the channel', org));

	const eventhubs = [];
  let client;
  let channel;

	return helper.getChannelForOrg(channelID, username, org)
		.then(_channel=>{
      channel = _channel;
      client = channel.getClient();

			logger.info(util.format('received member object for admin of the organization "%s": ', org));
			tx_id = client.newTransactionID();
			let request = {
				txId : 	tx_id
			};

			return channel.getGenesisBlock(request);
		}).then((genesis_block) => {
			tx_id = client.newTransactionID();
			const request = {
				targets: helper.newPeers(peers),
				txId: tx_id,
				block: genesis_block
			};

			for (let key in ORGS[org]) {
				if (ORGS[org].hasOwnProperty(key)) {
					if (key.indexOf('peer') === 0) {
						let data = fs.readFileSync(path.join(CONFIG_DIR, ORGS[org][key]['tls_cacerts']));
						let eh = client.newEventHub();
						eh.setPeerAddr(ORGS[org][key].events, {
							pem: Buffer.from(data).toString(),
							'ssl-target-name-override': ORGS[org][key]['server-hostname']
						});
						eh.connect();
						eventhubs.push(eh);
						allEventhubs.push(eh);
					}
				}
			}

			const eventPromises = [];
			eventhubs.forEach((eh) => {
				let txPromise = new Promise((resolve, reject) => {

					let handle = setTimeout(function(){
							reject('Timeout');
					}, parseInt(config.eventWaitTime));


					eh.registerBlockEvent((block) => {
						clearTimeout(handle);
						// in real-world situations, a peer may have more than one channels so
						// TODO: we must check that this block came from the channel we asked the peer to join
						if (block.data.data.length === 1) {
							// Config block must only contain one transaction
							const channel_header = block.data.data[0].payload.header.channel_header;
							if (channel_header.channel_id === channelID) {
								resolve();
							} else {
								reject();
							}
						}
					}, function(err){
							reject(err);
					});
				});
				eventPromises.push(txPromise);
			});
			let sendPromise = channel.joinChannel(request);
			return Promise.all([sendPromise].concat(eventPromises));
		}).then((results) => {
			logger.debug(util.format('Join Channel R E S P O N S E : %j', results));
			if (results[0] && results[0][0] && results[0][0].response && results[0][0].response.status === 200) {

				logger.info(util.format('Successfully joined peers in organization %s to the channel \'%s\'', org, channelID));
				closeConnections(true);

				return {
          success: true,
          message: util.format('Successfully joined peers in organization %s to the channel \'%s\'', org, channelID)
        };
			} else {
				logger.error(' Failed to join channel');
				closeConnections();
				throw new Error('Failed to join channel');
			}
		}).catch((err) => {
			err = err || {};
			logger.error('Failed to join channel due to error: ' + err.stack ? err.stack : err);
			closeConnections();
			throw new Error('Failed to join channel due to error: ' + err.stack ? err.stack : err);
		});
};
exports.joinChannel = joinChannel;
