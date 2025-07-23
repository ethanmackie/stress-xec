import { Wallet } from 'ecash-wallet';
import { ChronikClient } from 'chronik-client';
import fs from 'fs';

// Stress Test Configuration
const WALLET_MNEMONIC = 'INSERT MNEMONIC';
const NUM_TRANSACTIONS = 5;
const SATS_PER_TRANSACTION = 1000n; // 10 XEC (1000 satoshis)
const LOG_FILE_PATH = 'stresslog.csv';

const chronik = new ChronikClient(['https://chronik-testnet2.fabien.cash']);

type TransactionStatus = { status: string; time: string };

function getTimestamp(): string {
    return new Date().toISOString();
}

function getTimeOnly(): string {
    return new Date().toISOString().slice(11, 23);
}

function displayTable(txMap: Map<string, TransactionStatus>): void {
    const tableData = Array.from(txMap.entries()).map(([txid, data]) => ({
        txid: txid, status: data.status, time: data.time
    }));
    console.clear();
    console.table(tableData);
}

function exportLogsAndExit(eventLog: string[], reason: string): void {
    console.log(`\n${reason}`);
    const csvContent = 'timestamp,txid,event\n' + eventLog.join('\n');
    fs.writeFileSync(LOG_FILE_PATH, csvContent);
    console.log(`Exported to ${LOG_FILE_PATH}`);
    process.exit(0);
}

async function initializeWebSocket(
    txMap: Map<string, TransactionStatus>,
    eventLog: string[],
    totalTransactions: number,
    onAllFinalized: () => void,
) {
    let finalizedCount = 0;
    
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
            
            txMap.set(msg.txid, { status: msg.msgType, time: getTimeOnly() });
            displayTable(txMap);
        },
    });
    
    await ws.waitForOpen();
    return ws;
}

async function runStressTest(): Promise<void> {
    const eventLog: string[] = [];
    const txMap = new Map<string, TransactionStatus>();
    
    const wallet = Wallet.fromMnemonic(WALLET_MNEMONIC, chronik);
    await wallet.sync();

    const onAllFinalized = () => {
        console.log('All transactions finalized, exporting and exiting...');
        exportLogsAndExit(eventLog, `✅ All ${NUM_TRANSACTIONS} transactions finalized`);
    };
    
    const ws = await initializeWebSocket(txMap, eventLog, NUM_TRANSACTIONS, onAllFinalized);
    
    process.on('SIGINT', () => {
        exportLogsAndExit(eventLog, '⚠️ Manual exit');
    });
    for (let i = 0; i < NUM_TRANSACTIONS; i++) {
        const action = {
            outputs: [{ address: wallet.address, sats: SATS_PER_TRANSACTION }],
        };
        const tx = wallet.action(action).build();
        const txid = tx.tx.txid();
        
        ws.subscribeToTxid(txid);
        txMap.set(txid, { status: 'Broadcast', time: getTimeOnly() });
        eventLog.push(`${getTimestamp()},${txid},Broadcast`);
        
        await tx.broadcast();
        await wallet.sync();
    }
    
    displayTable(txMap);
    console.log('Waiting for all transactions to finalize...');
}

runStressTest().catch(console.error);
