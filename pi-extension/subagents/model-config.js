import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MODEL_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
function invalidModelConfig(source, message) {
    throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}
export function parseModelConfig(rawConfig, source = "config.json") {
    if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
        invalidModelConfig(source, "root must be an object");
    }
    const config = rawConfig;
    const models = config.models;
    if (models == null) return {
        agents: {}
    };
    if (typeof models !== "object" || Array.isArray(models)) {
        invalidModelConfig(source, "models must be an object");
    }
    const value = models;
    const allowedKeys = new Set([
        "default",
        "agents"
    ]);
    const unsupportedKeys = Object.keys(value).filter((key)=>!allowedKeys.has(key));
    if (unsupportedKeys.length > 0) {
        invalidModelConfig(source, `models has unsupported key(s): ${unsupportedKeys.join(", ")}`);
    }
    let defaultModel;
    if (value.default != null) {
        if (typeof value.default !== "string" || value.default.trim() === "") {
            invalidModelConfig(source, "models.default must be a non-empty string");
        }
        defaultModel = value.default.trim();
    }
    const agents = {};
    if (value.agents != null) {
        if (typeof value.agents !== "object" || Array.isArray(value.agents)) {
            invalidModelConfig(source, "models.agents must be an object");
        }
        for (const [agent, model] of Object.entries(value.agents)){
            if (typeof model !== "string" || model.trim() === "") {
                invalidModelConfig(source, `models.agents.${agent} must be a non-empty string`);
            }
            Object.defineProperty(agents, agent, {
                value: model.trim(),
                enumerable: true,
                writable: true,
                configurable: true
            });
        }
    }
    return {
        default: defaultModel,
        agents
    };
}
export function resolveModelDefault(agentName, agentModel, config) {
    if (agentModel) return agentModel;
    if (agentName && Object.hasOwn(config.agents, agentName)) {
        return config.agents[agentName];
    }
    return config.default;
}
export function loadModelConfig(configPath = DEFAULT_MODEL_CONFIG_PATH) {
    let raw;
    try {
        raw = readFileSync(configPath, "utf8");
    } catch (error) {
        const errno = error;
        if (errno.code === "ENOENT") return {
            agents: {}
        };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSON in subagent model config ${configPath}: ${detail}`);
    }
    return parseModelConfig(parsed, configPath);
}
