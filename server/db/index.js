const crypto = require('crypto');

// In-memory store — production would use PostgreSQL/Redis
const users = new Map();   // username → user object
const userById = new Map(); // id → user object
const rounds = [];          // ring buffer, last 100 rounds

function createUser(username, passwordHash) {
  const id = crypto.randomUUID();
  const user = {
    id,
    username,
    passwordHash,
    balance: 1000.00,          // starting balance
    createdAt: Date.now(),
  };
  users.set(username.toLowerCase(), user);
  userById.set(id, user);
  return user;
}

function findUserByUsername(username) {
  return users.get(username.toLowerCase()) || null;
}

function findUserById(id) {
  return userById.get(id) || null;
}

// amount can be negative (deduct) or positive (credit)
// Returns the updated user, or null if balance would go below 0
function updateBalance(userId, amount) {
  const user = userById.get(userId);
  if (!user) return null;
  const next = Math.round((user.balance + amount) * 100) / 100;
  if (next < 0) return null; // guard — caller must pre-check
  user.balance = next;
  return user;
}

function addRound(round) {
  rounds.push(round);
  if (rounds.length > 100) rounds.shift();
}

function getRecentRounds(limit = 30) {
  return rounds.slice(-limit).reverse();
}

module.exports = {
  createUser,
  findUserByUsername,
  findUserById,
  updateBalance,
  addRound,
  getRecentRounds,
};
