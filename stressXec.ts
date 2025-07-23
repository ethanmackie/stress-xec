import { Wallet } from 'ecash-wallet';
import { ChronikClient } from 'chronik-client';
import fs from 'fs';

// Stress Test Configuration
const WALLET_MNEMONIC = 'INSERT MNEMONIC'; // wallet that will create all transactions
const NUM_TRANSACTIONS = 5; // number of transactions to create
const SATS_TO_SEND = 1000n; // sats to be sent in each transaction (10 XEC)

const chronik = new ChronikClient(['https://chronik-testnet2.fabien.cash']);

async function initializeWebSocket(
    txMap: Map<string, string>,
    eventLog: string[],
    totalTransactions: number,
    onAllFinalized: () => void,
) {
    let finalizedCount = 0;
    
    try {
        const ws = chronik.ws({
            onMessage: (msg: any) => {
                eventLog.push(`${getTimestamp()},${msg.txid},${msg.msgType}`);
                if (msg.msgType === 'TX_FINALIZED') {
                    ws.unsubscribeFromTxid(msg.txid);
                    finalizedCount++;
                    
                    if (finalizedCount === totalTransactions) {
                        onAllFinalized();
                        return;
                    }
                }
                txMap.set(msg.txid, msg.msgType);
                console.clear();
                console.table(txMap);
            },
            onReconnect: (e: any) => {
                // WebSocket reconnecting
            },
        });
        await ws.waitForOpen();
        return ws;
    } catch (err: any) {
        throw err;
    }
}

// Helper function to get current timestamp
function getTimestamp(): string {
    return new Date().toISOString();
}

function exportLogsAndExit(eventLog: string[], reason: string) {
    console.log(`\n${reason}`);
    const csvContent = 'timestamp,txid,event\n' + eventLog.join('\n');
    const filePath = 'stresslog.csv';
    fs.writeFileSync(filePath, csvContent);
    console.log(`Exported to ${filePath}`);
    process.exit(0);
}

// Main stress test function
async function runStressTest() {
    const eventLog: string[] = [];
    
    const wallet = Wallet.fromMnemonic(WALLET_MNEMONIC, chronik);
    await wallet.sync();

    const txMap = new Map<string, string>();
    
    let processCompleted = false;
    const onAllFinalized = () => {
        console.log('All transactions finalized, exporting and exiting...');
        processCompleted = true;
        exportLogsAndExit(eventLog, `✅ All ${NUM_TRANSACTIONS} transactions finalized`);
    };
    
    const ws = await initializeWebSocket(txMap, eventLog, NUM_TRANSACTIONS, onAllFinalized);
    
    for (let i = 0; i < NUM_TRANSACTIONS; i++) {
        const action = {
            outputs: [{ address: wallet.address, sats: SATS_TO_SEND }],
        };
        const tx = wallet.action(action).build();
        
        const txid = tx.tx.txid();
        
        ws.subscribeToTxid(txid);
    
        txMap.set(txid, 'Broadcast');
        eventLog.push(`${getTimestamp()},${txid},Broadcast`);

        await tx.broadcast();        
        await wallet.sync();
    }
    
    console.clear();
    console.table(txMap);
    
    // Handle manual exit (Ctrl+C) if needed
    process.on('SIGINT', () => {
        if (!processCompleted) {
            exportLogsAndExit(eventLog, '⚠️ Manual exit');
        } else {
            process.exit(0);
        }
    });
    
    // Wait for all transactions to be finalized
    console.log('Waiting for all transactions to finalize...');
    while (!processCompleted) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

runStressTest().catch(console.error);