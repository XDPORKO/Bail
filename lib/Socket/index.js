"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const D = require("../Defaults");
const R = require("./registration");

const M = (c) => ((0, R.makeRegistrationSocket)({
    ...D.DEFAULT_CONNECTION_CONFIG,
    ...c
}));

exports.default = M;
exports.makeWASocket = M;