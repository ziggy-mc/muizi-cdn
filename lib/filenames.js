'use strict';
const { displayName } = require('./security');
// Conservative whole-word defaults. Operators can replace this list for their
// audience/language; this is filename cleanup, not a general moderation system.
const DEFAULT_REDACT_WORDS = Object.freeze([
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'motherfucker',
  'shit', 'bullshit', 'bitch', 'bitches', 'cunt', 'cunts', 'asshole',
  'assholes', 'bastard', 'bastards', 'dick', 'cock', 'pussy',
  'nigger', 'niggers', 'nigga', 'niggas', 'faggot', 'faggots'
]);
function filenameFilter(config) {
  const words = [...config.filenameWords].map(w => w.normalize('NFKC')).sort((a, b) => b.length - a.length);
  const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = escaped.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  return value => {
    let name = displayName(typeof value === 'string' ? value.normalize('NFKC') : value).toWellFormed().replace(/[<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_');
    if (pattern) name = name.replace(pattern, () => config.filenameReplacement);
    name = Array.from(name.replace(/[. ]+$/g, '').trim()).slice(0, 200).join('');
    if (pattern && !config.filenameReplacement && name.startsWith('.')) name = 'download' + name;
    if (!name || name === '.' || name === '..') name = 'download';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
    return name;
  };
}
module.exports = { DEFAULT_REDACT_WORDS, filenameFilter };
