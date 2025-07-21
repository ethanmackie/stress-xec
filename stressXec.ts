import { Wallet } from 'ecash-wallet';
import { ChronikClient } from 'chronik-client';
import fs from 'fs';
const bip39 = require('bip39');

// Stress Test Configuration
const FUNDING_MNEMONIC = 'INSERT MNEMONIC'; // wallet that will fund all the minion wallets
const NUM_WALLETS = 10; // number of minion wallets to generate
const SATS_TO_FUND = 2000n; // fund each NUM_WALLETS with sats (20 XEC)
const SATS_TO_SEND = 1000n; // sats to be sent from each generated wallet to itself (10 XEC)

const chronik = new ChronikClient(['https://chronik-testnet2.fabien.cash']);

// Helper to create and sync a wallet
async function createAndSyncWallet(mnemonic: string | null = null) {
    const wallet = mnemonic
        ? Wallet.fromMnemonic(mnemonic, chronik)
        : Wallet.fromMnemonic(bip39.generateMnemonic(), chronik);
    await wallet.sync();
    return wallet;
}

// Subscribe to all txid
async function subscribeToAllTxids(
    txids: string[],
    txMap: Map<string, string>,
    eventLog: string[],
) {
    try {
        const ws = chronik.ws({
            onMessage: (msg: any) => {
                eventLog.push(`${msg.txid}, ${msg.msgType}`);
                if (msg.type === 'TX_FINALIZED') {
                    ws.unsubscribeFromTxid(msg.txid);
                    console.log(`Unsubscribed from ${msg.txid}`);
                }
                txMap.set(msg.txid, msg.msgType);
                console.clear();
                console.table(txMap);
            },
            onReconnect: (e: any) => {
                console.log(
                    'subscribeToAllTxids(): Reconnecting websocket, disconnection cause: ',
                    e,
                );
            },
        });
        await ws.waitForOpen();
        for (const thisTxid of txids) {
            ws.subscribeToTxid(thisTxid);
        }
    } catch (err: any) {
        console.log(
            'subscribeToAllTxids: Error in chronik websocket subscription: ' +
                err,
        );
    }
}

// Main stress test function
async function runStressTest() {
    const eventLog: string[] = [];
    // Use FUNDING_MNEMONIC for the funding wallet
    const fundingWallet = await createAndSyncWallet(FUNDING_MNEMONIC);
    
    // Generate new mnemonics for each minion wallet
    const wallets: Wallet[] = [];
    for (let i = 0; i < NUM_WALLETS; i++) {
        const wallet = await createAndSyncWallet(null);
        wallets.push(wallet);
    }

    // Build funding tx: send SATS_TO_FUND to each minion wallet
    const fundingAction = {
        outputs: wallets.map(w => ({ 
            address: w.address, 
            sats: SATS_TO_FUND 
        })),
    };

    const walletAction = fundingWallet.action(fundingAction);
    
    let fundingTx;
    try {
        fundingTx = walletAction.build();
    } catch (error: any) {
        console.log('Build error details:', error.message);
        throw error;
    }
    const fundingTxResponse = await fundingTx.broadcast();
    console.log(`Initial funding broadcast Response: `, fundingTxResponse);

    // Sync minion wallets after funding
    for (const w of wallets) {
        await w.sync();
    }
    // Each minion wallet sends SATS_TO_SEND to itself
    const stressTxs: string[] = [];
    for (const thisWallet of wallets) {
        const action = {
            outputs: [{ address: thisWallet.address, sats: SATS_TO_SEND }],
        };
        const tx = thisWallet.action(action).build();
        stressTxs.push(tx.tx.toHex());
    }

    console.log(`Broadcasting ${stressTxs.length} stress txs...`);
    const stressTxResponse = await chronik.broadcastTxs(stressTxs);
    const txMap = new Map<string, string>();
    for (const thisTxid of stressTxResponse.txids) {
        txMap.set(thisTxid, 'Unconfirmed');
        eventLog.push(`${thisTxid}, Unconfirmed`);
    }
    console.clear();
    console.table(txMap);
    await subscribeToAllTxids(stressTxResponse.txids, txMap, eventLog);
    process.on('SIGINT', () => {
        console.log('Exiting tool, exporting event log...');
        const csvEventLog = eventLog.join(',\n');
        const filePath = 'stresslog.csv';
        fs.writeFileSync(filePath, csvEventLog);
        console.log(`Exported to CSV file ${filePath}.`);
        process.exit();
    });
}

runStressTest().catch(console.error);