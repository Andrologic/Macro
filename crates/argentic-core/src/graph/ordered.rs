//! Insertion-ordered sets and maps with the iteration and replacement rules of
//! the JS `Set` and `Map` used by the 0.3 graph and validator code. A `set` on
//! an existing key replaces the value in place and keeps its position.
use std::{borrow::Borrow, collections::HashMap, hash::Hash};

#[derive(Clone, Debug)]
pub(crate) struct OrderedSet<K> {
    items: Vec<K>,
    index: HashMap<K, usize>,
}

impl<K> Default for OrderedSet<K> {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash + Clone> OrderedSet<K> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// `set.add(key)`: returns whether the key was new.
    pub(crate) fn insert(&mut self, key: K) -> bool {
        if self.index.contains_key(&key) {
            return false;
        }
        self.index.insert(key.clone(), self.items.len());
        self.items.push(key);
        true
    }

    pub(crate) fn contains<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.index.contains_key(key)
    }

    pub(crate) fn len(&self) -> usize {
        self.items.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub(crate) fn iter(&self) -> std::slice::Iter<'_, K> {
        self.items.iter()
    }

    /// `new Set([...a].filter((value) => b.has(value)))`.
    pub(crate) fn intersection(&self, other: &Self) -> Self {
        self.iter()
            .filter(|key| other.contains(*key))
            .cloned()
            .collect()
    }

    /// Same size and every member of `self` in `other`.
    pub(crate) fn same_set(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().all(|key| other.contains(key))
    }
}

impl<K: Eq + Hash + Clone> FromIterator<K> for OrderedSet<K> {
    fn from_iter<I: IntoIterator<Item = K>>(iter: I) -> Self {
        let mut set = Self::new();
        for key in iter {
            set.insert(key);
        }
        set
    }
}

impl<'s, K> IntoIterator for &'s OrderedSet<K> {
    type Item = &'s K;
    type IntoIter = std::slice::Iter<'s, K>;
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}

#[derive(Clone, Debug)]
pub(crate) struct OrderedMap<K, V> {
    keys: Vec<K>,
    values: Vec<V>,
    index: HashMap<K, usize>,
}

impl<K, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        Self {
            keys: Vec::new(),
            values: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<K: Eq + Hash + Clone, V> OrderedMap<K, V> {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// `map.set(key, value)`: replacement keeps the first position.
    pub(crate) fn set(&mut self, key: K, value: V) {
        if let Some(&at) = self.index.get(&key) {
            self.values[at] = value;
            return;
        }
        self.index.insert(key.clone(), self.keys.len());
        self.keys.push(key);
        self.values.push(value);
    }

    pub(crate) fn get<Q>(&self, key: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.index.get(key).map(|&at| &self.values[at])
    }

    pub(crate) fn get_mut<Q>(&mut self, key: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.index.get(key).map(|&at| &mut self.values[at])
    }

    pub(crate) fn contains_key<Q>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + Hash + ?Sized,
    {
        self.index.contains_key(key)
    }

    pub(crate) fn len(&self) -> usize {
        self.keys.len()
    }

    pub(crate) fn keys(&self) -> std::slice::Iter<'_, K> {
        self.keys.iter()
    }

    pub(crate) fn values(&self) -> std::slice::Iter<'_, V> {
        self.values.iter()
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.keys.iter().zip(self.values.iter())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_replacement_keeps_position_like_js_map() {
        let mut map = OrderedMap::new();
        map.set("b", 1);
        map.set("a", 2);
        map.set("b", 3);
        assert_eq!(map.iter().collect::<Vec<_>>(), vec![(&"b", &3), (&"a", &2)]);
        let set: OrderedSet<&str> = ["z", "a", "z", "m"].into_iter().collect();
        assert_eq!(set.iter().copied().collect::<Vec<_>>(), vec!["z", "a", "m"]);
        let other: OrderedSet<&str> = ["m", "z"].into_iter().collect();
        assert_eq!(
            set.intersection(&other).iter().copied().collect::<Vec<_>>(),
            vec!["z", "m"]
        );
    }
}
