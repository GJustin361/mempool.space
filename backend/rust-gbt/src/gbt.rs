use priority_queue::PriorityQueue;
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};
use tracing::{info, trace};

use crate::{
    audit_transaction::AuditTransaction,
    u32_hasher_types::{
        u32hashmap_with_capacity, u32hashset_new, u32priority_queue_with_capacity, U32HasherState,
    },
    GbtResult, ThreadTransactionsMap, STARTING_CAPACITY,
};

const MAX_BLOCK_WEIGHT_UNITS: u32 = 4_000_000 - 4_000;
const BLOCK_SIGOPS: u32 = 80_000;
const BLOCK_RESERVED_WEIGHT: u32 = 4_000;
const BLOCK_RESERVED_SIGOPS: u32 = 400;
const MAX_BLOCKS: usize = 8;

type AuditPool = HashMap<u32, AuditTransaction, U32HasherState>;
type ModifiedQueue = PriorityQueue<u32, TxPriority, U32HasherState>;

#[derive(Debug)]
struct TxPriority {
    uid: u32,
    score: f64,
}
impl PartialEq for TxPriority {
    fn eq(&self, other: &Self) -> bool {
        self.uid == other.uid
    }
}
impl Eq for TxPriority {}
impl PartialOrd for TxPriority {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        if self.score == other.score {
            Some(self.uid.cmp(&other.uid))
        } else {
            self.score.partial_cmp(&other.score)
        }
    }
}
impl Ord for TxPriority {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).expect("score will never be NaN")
    }
}

/// Build projected mempool blocks using an approximation of the transaction selection algorithm from Bitcoin Core
///
/// See `BlockAssembler` in Bitcoin Core's
/// [miner.cpp](https://github.com/bitcoin/bitcoin/blob/master/src/node/miner.cpp).
/// Ported from mempool backend's
/// [tx-selection-worker.ts](https://github.com/mempool/mempool/blob/master/backend/src/api/tx-selection-worker.ts).
//
// TODO: Make gbt smaller to fix these lints.
#[allow(clippy::too_many_lines)]
#[allow(clippy::cognitive_complexity)]
pub fn gbt(mempool: &mut ThreadTransactionsMap) -> GbtResult {
    let mut audit_pool: AuditPool = u32hashmap_with_capacity(STARTING_CAPACITY);
    let mut mempool_stack: Vec<u32> = Vec::with_capacity(STARTING_CAPACITY);
    let mut clusters: Vec<Vec<u32>> = Vec::new();

    info!("Initializing working structs");
    for (uid, tx) in mempool {
        let audit_tx = AuditTransaction::from_thread_transaction(tx);
        // Safety: audit_pool and mempool_stack must always contain the same transactions
        audit_pool.insert(audit_tx.uid, audit_tx);
        mempool_stack.push(*uid);
    }

    info!("Building relatives graph & calculate ancestor scores");
    for txid in &mempool_stack {
        set_relatives(*txid, &mut audit_pool);
    }
    trace!("Post relative graph Audit Pool: {:#?}", audit_pool);

    info!("Sorting by descending ancestor score");
    mempool_stack.sort_unstable_by(|a, b| {
        let a_tx = audit_pool
            .get(a)
            .expect("audit_pool contains exact same txes as mempool_stack");
        let b_tx = audit_pool
            .get(b)
            .expect("audit_pool contains exact same txes as mempool_stack");
        a_tx.cmp(b_tx)
    });

    info!("Building blocks by greedily choosing the highest feerate package");
    info!("(i.e. the package rooted in the transaction with the best ancestor score)");
    let mut blocks: Vec<Vec<u32>> = Vec::new();
    let mut block_weight: u32 = BLOCK_RESERVED_WEIGHT;
    let mut block_sigops: u32 = BLOCK_RESERVED_SIGOPS;
    let mut transactions: Vec<u32> = Vec::with_capacity(STARTING_CAPACITY);
    let mut modified: ModifiedQueue = u32priority_queue_with_capacity(STARTING_CAPACITY);
    let mut overflow: Vec<u32> = Vec::new();
    let mut failures = 0;
    while !mempool_stack.is_empty() || !modified.is_empty() {
        // This trace log storm is big, so to make scrolling through
        // Each iteration easier, leaving a bunch of empty rows
        // And a header of ======
        trace!("\n\n\n\n\n\n\n\n\n\n==================================");
        trace!("mempool_array: {:#?}", mempool_stack);
        trace!("clusters: {:#?}", clusters);
        trace!("modified: {:#?}", modified);
        trace!("audit_pool: {:#?}", audit_pool);
        trace!("blocks: {:#?}", blocks);
        trace!("block_weight: {:#?}", block_weight);
        trace!("block_sigops: {:#?}", block_sigops);
        trace!("transactions: {:#?}", transactions);
        trace!("overflow: {:#?}", overflow);
        trace!("failures: {:#?}", failures);
        trace!("\n==================================");

        let next_from_stack = next_valid_from_stack(&mut mempool_stack, &audit_pool);
        let next_from_queue = next_valid_from_queue(&mut modified, &audit_pool);
        if next_from_stack.is_none() && next_from_queue.is_none() {
            continue;
        }
        let (next_tx, from_stack) = match (next_from_stack, next_from_queue) {
            (Some(stack_tx), Some(queue_tx)) => match queue_tx.cmp(stack_tx) {
                std::cmp::Ordering::Less => (stack_tx, true),
                _ => (queue_tx, false),
            },
            (Some(stack_tx), None) => (stack_tx, true),
            (None, Some(queue_tx)) => (queue_tx, false),
            (None, None) => unreachable!(),
        };

        if from_stack {
            mempool_stack.pop();
        } else {
            modified.pop();
        }

        if blocks.len() < (MAX_BLOCKS - 1)
            && ((block_weight + (4 * next_tx.ancestor_sigop_adjusted_vsize()) >= MAX_BLOCK_WEIGHT_UNITS)
                || (block_sigops + next_tx.ancestor_sigops() > BLOCK_SIGOPS))
        {
            // hold this package in an overflow list while we check for smaller options
            overflow.push(next_tx.uid);
            failures += 1;
        } else {
            let mut package: Vec<(u32, usize)> = Vec::new();
            let mut cluster: Vec<u32> = Vec::new();
            let is_cluster: bool = !next_tx.ancestors.is_empty();
            for ancestor_id in &next_tx.ancestors {
                if let Some(ancestor) = audit_pool.get(ancestor_id) {
                    package.push((*ancestor_id, ancestor.ancestors.len()));
                }
            }
            package.sort_unstable_by(|a, b| -> Ordering {
                if a.1 == b.1 {
                    b.0.cmp(&a.0)
                } else {
                    a.1.cmp(&b.1)
                }
            });
            package.push((next_tx.uid, next_tx.ancestors.len()));

            let cluster_rate = next_tx.cluster_rate();

            for (txid, _) in &package {
                cluster.push(*txid);
                if let Some(tx) = audit_pool.get_mut(txid) {
                    tx.used = true;
                    tx.set_dirty_if_different(cluster_rate);
                    transactions.push(tx.uid);
                    block_weight += tx.weight;
                    block_sigops += tx.sigops;
                }
                update_descendants(*txid, &mut audit_pool, &mut modified, cluster_rate);
            }

            if is_cluster {
                clusters.push(cluster);
            }

            failures = 0;
        }

        // this block is full
        let exceeded_package_tries =
            failures > 1000 && block_weight > (MAX_BLOCK_WEIGHT_UNITS - BLOCK_RESERVED_WEIGHT);
        let queue_is_empty = mempool_stack.is_empty() && modified.is_empty();
        if (exceeded_package_tries || queue_is_empty) && blocks.len() < (MAX_BLOCKS - 1) {
            // finalize this block
            if !transactions.is_empty() {
                blocks.push(transactions);
            }
            // reset for the next block
            transactions = Vec::with_capacity(STARTING_CAPACITY);
            block_weight = BLOCK_RESERVED_WEIGHT;
            block_sigops = BLOCK_RESERVED_SIGOPS;
            failures = 0;
            // 'overflow' packages didn't fit in this block, but are valid candidates for the next
            overflow.reverse();
            for overflowed in &overflow {
                if let Some(overflowed_tx) = audit_pool.get(overflowed) {
                    if overflowed_tx.modified {
                        modified.push(
                            *overflowed,
                            TxPriority {
                                uid: *overflowed,
                                score: overflowed_tx.score(),
                            },
                        );
                    } else {
                        mempool_stack.push(*overflowed);
                    }
                }
            }
            overflow = Vec::new();
        }
    }
    // add the final unbounded block if it contains any transactions
    if !transactions.is_empty() {
        blocks.push(transactions);
    }

    // make a list of dirty transactions and their new rates
    let mut rates: Vec<Vec<f64>> = Vec::new();
    for (txid, tx) in audit_pool {
        trace!("txid: {}, is_dirty: {}", txid, tx.dirty);
        if tx.dirty {
            rates.push(vec![f64::from(txid), tx.effective_fee_per_vsize]);
        }
    }
    trace!("\n\n\n\n\n====================");
    trace!("blocks: {:#?}", blocks);
    trace!("clusters: {:#?}", clusters);
    trace!("rates: {:#?}\n====================\n\n\n\n\n", rates);

    GbtResult {
        blocks,
        clusters,
        rates,
    }
}

fn next_valid_from_stack<'a>(
    mempool_stack: &mut Vec<u32>,
    audit_pool: &'a AuditPool,
) -> Option<&'a AuditTransaction> {
    let mut next_txid = mempool_stack.last()?;
    let mut tx: &AuditTransaction = audit_pool.get(next_txid)?;
    while tx.used || tx.modified {
        mempool_stack.pop();
        next_txid = mempool_stack.last()?;
        tx = audit_pool.get(next_txid)?;
    }
    Some(tx)
}

fn next_valid_from_queue<'a>(
    queue: &mut ModifiedQueue,
    audit_pool: &'a AuditPool,
) -> Option<&'a AuditTransaction> {
    let mut next_txid = queue.peek()?.0;
    let mut tx: &AuditTransaction = audit_pool.get(next_txid)?;
    while tx.used {
        queue.pop();
        next_txid = queue.peek()?.0;
        tx = audit_pool.get(next_txid)?;
    }
    Some(tx)
}

fn set_relatives(txid: u32, audit_pool: &mut AuditPool) {
    let mut parents: HashSet<u32, U32HasherState> = u32hashset_new();
    if let Some(tx) = audit_pool.get(&txid) {
        if tx.relatives_set_flag {
            return;
        }
        for input in &tx.inputs {
            parents.insert(*input);
        }
    } else {
        return;
    }

    let mut ancestors: HashSet<u32, U32HasherState> = u32hashset_new();
    for parent_id in &parents {
        set_relatives(*parent_id, audit_pool);

        if let Some(parent) = audit_pool.get_mut(parent_id) {
            // Safety: ancestors must always contain only txes in audit_pool
            ancestors.insert(*parent_id);
            parent.children.insert(txid);
            for ancestor in &parent.ancestors {
                ancestors.insert(*ancestor);
            }
        }
    }

    let mut total_fee: u64 = 0;
    let mut total_weight: u32 = 0;
    let mut total_sigop_adjusted_vsize: u32 = 0;
    let mut total_sigops: u32 = 0;

    for ancestor_id in &ancestors {
        let ancestor = audit_pool
            .get(ancestor_id)
            .expect("audit_pool contains all ancestors");
        total_fee += ancestor.fee;
        total_weight += ancestor.weight;
        total_sigop_adjusted_vsize += ancestor.sigop_adjusted_vsize;
        total_sigops += ancestor.sigops;
    }

    if let Some(tx) = audit_pool.get_mut(&txid) {
        tx.set_ancestors(ancestors, total_fee, total_weight, total_sigop_adjusted_vsize, total_sigops);
    }
}

// iterate over remaining descendants, removing the root as a valid ancestor & updating the ancestor score
fn update_descendants(
    root_txid: u32,
    audit_pool: &mut AuditPool,
    modified: &mut ModifiedQueue,
    cluster_rate: f64,
) {
    let mut visited: HashSet<u32, U32HasherState> = u32hashset_new();
    let mut descendant_stack: Vec<u32> = Vec::new();
    let root_fee: u64;
    let root_weight: u32;
    let root_sigop_adjusted_vsize: u32;
    let root_sigops: u32;
    if let Some(root_tx) = audit_pool.get(&root_txid) {
        for descendant_id in &root_tx.children {
            if !visited.contains(descendant_id) {
                descendant_stack.push(*descendant_id);
                visited.insert(*descendant_id);
            }
        }
        root_fee = root_tx.fee;
        root_weight = root_tx.weight;
        root_sigop_adjusted_vsize = root_tx.sigop_adjusted_vsize;
        root_sigops = root_tx.sigops;
    } else {
        return;
    }
    while let Some(next_txid) = descendant_stack.pop() {
        if let Some(descendant) = audit_pool.get_mut(&next_txid) {
            // remove root tx as ancestor
            let old_score =
                descendant.remove_root(root_txid, root_fee, root_weight, root_sigop_adjusted_vsize, root_sigops, cluster_rate);
            // add to priority queue or update priority if score has changed
            if descendant.score() < old_score {
                descendant.modified = true;
                modified.push_decrease(
                    descendant.uid,
                    TxPriority {
                        uid: descendant.uid,
                        score: descendant.score(),
                    },
                );
            } else if descendant.score() > old_score {
                descendant.modified = true;
                modified.push_increase(
                    descendant.uid,
                    TxPriority {
                        uid: descendant.uid,
                        score: descendant.score(),
                    },
                );
            }

            // add this node's children to the stack
            for child_id in &descendant.children {
                if !visited.contains(child_id) {
                    descendant_stack.push(*child_id);
                    visited.insert(*child_id);
                }
            }
        }
    }
}
