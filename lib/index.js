"use strict";

const x = require("chalk");

(function () {
    console.log(
        x.magentaBright(`
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⢸⣿⣿⣷⣜⢿⣧⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡄⠻⣿⣿⣿⣿⣦⠄⠄
.....
╔════════════════════════════════════════════╗
║        ✧ Baileys Mod /<>/ v1.2 Pro ✧               ║
╚════════════════════════════════════════════╝
`)
    );
    console.log(x.redBright("Thanks Using My Baileys"));
    console.log(x.magentaBright("Report Error: ") + x.redBright("@RapixOffc"));
    console.log(x.magenta("\n✧──────────────────────────────────────✧\n"));
})();

var __b = (this && this.__createBinding) || (Object.create
    ? function (a, b, d, e) {
          if (e === undefined) e = d;
          var f = Object.getOwnPropertyDescriptor(b, d);
          if (!f || ("get" in f ? !b.__esModule : f.writable || f.configurable)) {
              f = { enumerable: true, get: function () { return b[d]; } };
          }
          Object.defineProperty(a, e, f);
      }
    : function (a, b, d, e) {
          if (e === undefined) e = d;
          a[e] = b[d];
      }
);

var __e = (this && this.__exportStar) || function (a, b) {
    for (var d in a) if (d !== "default" && Object.prototype.hasOwnProperty.call(a, d)) __b(b, a, d);
};

var __i = (this && this.__importDefault) || function (a) {
    return a && a.__esModule ? a : { default: a };
};

Object.defineProperty(exports, " __esModule", { value: true });
exports.makeWASocket = void 0;

const S = __i(require("./Socket"));
exports.makeWASocket = S.default;

__e(require("../WAProto"), exports);
__e(require("./Utils"), exports);
__e(require("./Types"), exports);
__e(require("./Store"), exports);
__e(require("./Defaults"), exports);
__e(require("./WABinary"), exports);
__e(require("./WAM"), exports);
__e(require("./WAUSync"), exports);

exports.default = S.default;
