const IMAGINE_EMBED_TITLE = 'Generated Image';

/**
 * @param {import('discord.js').Message | null | undefined} message
 * @returns {boolean}
 */
function isImagineImageMessage(message) {
  if (!message) return false;
  return (message.embeds ?? []).some(embed => embed.title === IMAGINE_EMBED_TITLE);
}

module.exports = {
  IMAGINE_EMBED_TITLE,
  isImagineImageMessage
};
