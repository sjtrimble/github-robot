import {createProbot} from "probot";
import {MergeTask} from './plugins/merge';
import {initializeApp, firestore, credential} from "firebase-admin";
import {join} from "path";

console.warn(`Starting dev mode`);

const config = require('../private/env.json');
const serviceAccount = require("../private/firebase-key.json");
initializeApp({
  credential: credential.cert(serviceAccount)
});

// Probot setup
const bot = createProbot(config);

// Load plugins
let mergeTask: MergeTask;
const store = firestore();
bot.setup([robot => {
  mergeTask = new MergeTask(robot, store);
}]);

// fix for probot view in dev mode
bot.server.set('views', join(__dirname, '../libs/probot/views'));

// Start the bot
bot.start();

export {bot, mergeTask};
