use crate::{
    thread_transaction::ThreadTransaction,
    u32_hasher_types::{u32hashset_new, U32HasherState},
};
use std::{
    cmp::Ordering,
    collections::HashSet,
    hash::{Hash, Hasher},
};

#[allow(clippy::struct_excessive_bools)]
#[derive(Clone, Debug)]
pub struct AuditTransaction {
    pub uid: u32,
    pub fee: u64,
    pub weight: u32,
    pub sigop_adjusted_vsize: u32,
    pub sigops: u32,
    pub fee_per_vsize: f64,
    pub effective_fee_per_vsize: f64,
    pub dependency_rate: f64,
    pub inputs: Vec<u32>,
    pub relatives_set_flag: bool,
    pub ancestors: HashSet<u32, U32HasherState>,
    pub children: HashSet<u32, U32HasherState>,
    ancestor_fee: u64,
    ancestor_weight: u32,
    ancestor_sigop_adjusted_vsize: u32,
    ancestor_sigops: u32,
    // Safety: Must be private to prevent NaN breaking Ord impl.
    score: f64,
    pub used: bool,
    /// whether this transaction has been moved to the "modified" priority queue
    pub modified: bool,
    pub dirty: bool,
}

impl Hash for AuditTransaction {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.uid.hash(state);
    }
}

impl PartialEq for AuditTransaction {
    fn eq(&self, other: &Self) -> bool {
        self.uid == other.uid
    }
}

impl Eq for AuditTransaction {}

#[inline]
pub fn partial_cmp_uid_score(a: (u32, f64), b: (u32, f64)) -> Option<Ordering> {
    // If either score is NaN, this is false,
    // and partial_cmp will return None
    if a.1 == b.1 {
        Some(a.0.cmp(&b.0))
    } else {
        a.1.partial_cmp(&b.1)
    }
}

impl PartialOrd for AuditTransaction {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        partial_cmp_uid_score((self.uid, self.score), (other.uid, other.score))
    }
}

impl Ord for AuditTransaction {
    fn cmp(&self, other: &Self) -> Ordering {
        // Safety: The only possible values for score are f64
        // that are not NaN. This is because outside code can not
        // freely assign score. Also, calc_new_score guarantees no NaN.
        self.partial_cmp(other).expect("score will never be NaN")
    }
}

impl AuditTransaction {
    pub fn from_thread_transaction(tx: &ThreadTransaction) -> Self {
        // rounded up to the nearest integer
        let sigop_adjusted_vsize = ((tx.weight + 3) / 4).max(tx.sigops * 5);
        Self {
            uid: tx.uid,
            fee: tx.fee,
            weight: tx.weight,
            sigop_adjusted_vsize,
            sigops: tx.sigops,
            fee_per_vsize: tx.fee_per_vsize,
            effective_fee_per_vsize: tx.effective_fee_per_vsize,
            dependency_rate: f64::INFINITY,
            inputs: tx.inputs.clone(),
            relatives_set_flag: false,
            ancestors: u32hashset_new(),
            children: u32hashset_new(),
            ancestor_fee: tx.fee,
            ancestor_weight: tx.weight,
            ancestor_sigop_adjusted_vsize: sigop_adjusted_vsize,
            ancestor_sigops: tx.sigops,
            score: 0.0,
            used: false,
            modified: false,
            dirty: false,
        }
    }

    #[inline]
    pub const fn score(&self) -> f64 {
        self.score
    }

    #[inline]
    pub const fn ancestor_sigop_adjusted_vsize(&self) -> u32 {
        self.ancestor_sigop_adjusted_vsize
    }

    #[inline]
    pub const fn ancestor_sigops(&self) -> u32 {
        self.ancestor_sigops
    }

    #[inline]
    pub fn cluster_rate(&self) -> f64 {
        // Safety: self.ancestor_weight can never be 0.
        // Even if it could, as it approaches 0, the value inside the min() call
        // grows, so if we think of 0 as "grew infinitely" then dependency_rate would be
        // the smaller of the two. If either side is NaN, the other side is returned.
        self.dependency_rate
            .min(self.ancestor_fee as f64 / (f64::from(self.ancestor_weight) / 4.0))
    }

    pub fn set_dirty_if_different(&mut self, cluster_rate: f64) {
        if self.effective_fee_per_vsize != cluster_rate {
            self.effective_fee_per_vsize = cluster_rate;
            self.dirty = true;
        }
    }

    /// Safety: This function must NEVER set score to NaN.
    #[inline]
    fn calc_new_score(&mut self) {
        self.score = (self.ancestor_fee as f64)
            / (if self.ancestor_sigop_adjusted_vsize == 0 {
                1.0
            } else {
                f64::from(self.ancestor_sigop_adjusted_vsize)
            });
    }

    #[inline]
    pub fn set_ancestors(
        &mut self,
        ancestors: HashSet<u32, U32HasherState>,
        total_fee: u64,
        total_weight: u32,
        total_sigop_adjusted_vsize: u32,
        total_sigops: u32,
    ) {
        self.ancestors = ancestors;
        self.ancestor_fee = self.fee + total_fee;
        self.ancestor_weight = self.weight + total_weight;
        self.ancestor_sigop_adjusted_vsize = self.sigop_adjusted_vsize + total_sigop_adjusted_vsize;
        self.ancestor_sigops = self.sigops + total_sigops;
        self.calc_new_score();
        self.relatives_set_flag = true;
    }

    #[inline]
    pub fn remove_root(
        &mut self,
        root_txid: u32,
        root_fee: u64,
        root_weight: u32,
        root_sigop_adjusted_vsize: u32,
        root_sigops: u32,
        cluster_rate: f64,
    ) -> f64 {
        let old_score = self.score();
        self.dependency_rate = self.dependency_rate.min(cluster_rate);
        if self.ancestors.remove(&root_txid) {
            self.ancestor_fee -= root_fee;
            self.ancestor_weight -= root_weight;
            self.ancestor_sigop_adjusted_vsize -= root_sigop_adjusted_vsize;
            self.ancestor_sigops -= root_sigops;
            self.calc_new_score();
        }
        old_score
    }
}
