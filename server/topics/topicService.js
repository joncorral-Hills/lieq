// server/topics/topicService.js
const topics = require('./topics.json');

const usedIds = new Set();

function getRandomTopic(tier, excludeIds = []) {
  const pool = topics.filter(
    t => t.tier === tier && !excludeIds.includes(t.id)
  );
  if (!pool.length) {
    // All topics in tier used — reset and re-draw
    const fallback = topics.filter(t => t.tier === tier);
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function getTopicsByTier(tier) {
  return topics.filter(t => t.tier === tier);
}

module.exports = { getRandomTopic, getTopicsByTier };
