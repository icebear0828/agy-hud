const { configureStatusLine } = require('./statusline.js');

module.exports = async (api) => {
  // Automatically configure the statusLine settings.json in the background
  try {
    configureStatusLine(__dirname);
  } catch {
    // Fail silently
  }

  if (api && api.registerHook) {
    // We can use hooks here to trigger HUD refreshes if needed, 
    // but agy calls the statusLine command automatically.
    api.registerHook('on_step_complete', async (context) => {
      // Step completed
    });
  }
};
