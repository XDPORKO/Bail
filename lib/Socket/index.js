"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

const DSCCSFFF_18388ZNS = require("../Defaults");
const RSJZIKWNW_9NXI92NZ00W = require("./registration");

const M = (c) => ((0, RSJZIKWNW_9NXI92NZ00W.makeRegistrationSocket)({
    ...DSCCSFFF_18388ZNS.DEFAULT_CONNECTION_CONFIG,
    ...c
}));

exports.default = M;
exports.makeWASocket = M;