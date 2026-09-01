import {createRequire} from "node:module";

const require=createRequire(import.meta.url);
const packageMetadata=require("../../package.json");

export const CORE_PACKAGE_VERSION=packageMetadata.version;
