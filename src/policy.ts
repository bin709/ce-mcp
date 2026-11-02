/**
 * 权限闸门：高危工具默认拒绝，只有 profile 放开或显式 allow 才放行。
 *
 *   safe     —— 只读
 *   standard —— 只读 + 写内存
 *   full     —— 全开（含 AutoAssemble / 执行 Lua / 注入 DLL / 变速）；默认档位
 */
import type { Config, Profile } from "./config.js";

export type RiskLevel = "read" | "write" | "execute" | "danger";

const PROFILE_LEVELS: Record<Profile, RiskLevel[]> = {
  safe: ["read"],
  standard: ["read", "write"],
  full: ["read", "write", "execute", "danger"],
};

export interface GateDecision {
  allowed: boolean;
  reason?: string;
  profile: Profile;
}

export class Policy {
  constructor(private readonly cfg: Config) {}

  get profile(): Profile {
    return this.cfg.profile;
  }

  /** 当前 profile 允许哪些等级 */
  allowedLevels(): RiskLevel[] {
    return PROFILE_LEVELS[this.cfg.profile];
  }

  decide(toolName: string, level: RiskLevel): GateDecision {
    if (this.cfg.deny.includes(toolName)) {
      return { allowed: false, profile: this.cfg.profile, reason: `工具 ${toolName} 在 deny 名单中` };
    }
    if (this.cfg.allow.includes(toolName)) {
      return { allowed: true, profile: this.cfg.profile };
    }
    if (PROFILE_LEVELS[this.cfg.profile].includes(level)) {
      return { allowed: true, profile: this.cfg.profile };
    }
    return {
      allowed: false,
      profile: this.cfg.profile,
      reason:
        `工具 ${toolName} 属于 ${level} 等级，当前 profile="${this.cfg.profile}" 未开启。` +
        `开启方式：设置环境变量 CE_MCP_PROFILE=full（或 standard），` +
        `或在 ${"~/.ce-mcp/config.json"} 里改 profile，或单独放行 CE_MCP_ALLOW=${toolName}。`,
    };
  }

  /** 配置摘要，暴露给 Agent 让它知道当前边界 */
  summary() {
    return {
      profile: this.cfg.profile,
      allowedLevels: this.allowedLevels(),
      allow: this.cfg.allow,
      deny: this.cfg.deny,
    };
  }
}
