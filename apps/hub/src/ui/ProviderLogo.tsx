// The mark of a model provider beside its name: its logo from LobeHub's icons, printed in the ink of
// the text through a mask, or its initial for a provider the set does not draw (and for the
// instance's own models: the WIC monogram may not be set under 24px).

import logo_anthropic from '@lobehub/icons-static-svg/icons/anthropic.svg?url'
import logo_azure from '@lobehub/icons-static-svg/icons/azure.svg?url'
import logo_baseten from '@lobehub/icons-static-svg/icons/baseten.svg?url'
import logo_bedrock from '@lobehub/icons-static-svg/icons/bedrock.svg?url'
import logo_cerebras from '@lobehub/icons-static-svg/icons/cerebras.svg?url'
import logo_cloudflare from '@lobehub/icons-static-svg/icons/cloudflare.svg?url'
import logo_codex from '@lobehub/icons-static-svg/icons/codex.svg?url'
import logo_deepseek from '@lobehub/icons-static-svg/icons/deepseek.svg?url'
import logo_fireworks from '@lobehub/icons-static-svg/icons/fireworks.svg?url'
import logo_githubcopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url'
import logo_google from '@lobehub/icons-static-svg/icons/google.svg?url'
import logo_groq from '@lobehub/icons-static-svg/icons/groq.svg?url'
import logo_huggingface from '@lobehub/icons-static-svg/icons/huggingface.svg?url'
import logo_kimi from '@lobehub/icons-static-svg/icons/kimi.svg?url'
import logo_ling from '@lobehub/icons-static-svg/icons/ling.svg?url'
import logo_meta from '@lobehub/icons-static-svg/icons/meta.svg?url'
import logo_minimax from '@lobehub/icons-static-svg/icons/minimax.svg?url'
import logo_mistral from '@lobehub/icons-static-svg/icons/mistral.svg?url'
import logo_moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?url'
import logo_nvidia from '@lobehub/icons-static-svg/icons/nvidia.svg?url'
import logo_openai from '@lobehub/icons-static-svg/icons/openai.svg?url'
import logo_opencode from '@lobehub/icons-static-svg/icons/opencode.svg?url'
import logo_openrouter from '@lobehub/icons-static-svg/icons/openrouter.svg?url'
import logo_qwen from '@lobehub/icons-static-svg/icons/qwen.svg?url'
import logo_together from '@lobehub/icons-static-svg/icons/together.svg?url'
import logo_vercel from '@lobehub/icons-static-svg/icons/vercel.svg?url'
import logo_vertexai from '@lobehub/icons-static-svg/icons/vertexai.svg?url'
import logo_workersai from '@lobehub/icons-static-svg/icons/workersai.svg?url'
import logo_xai from '@lobehub/icons-static-svg/icons/xai.svg?url'
import logo_xiaomimimo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?url'
import logo_zai from '@lobehub/icons-static-svg/icons/zai.svg?url'

/** Logo of each pi-ai provider; regional and plan variants share their family's. */
const LOGOS: Record<string, string> = {
  'amazon-bedrock': logo_bedrock,
  'ant-ling': logo_ling,
  anthropic: logo_anthropic,
  azure: logo_azure,
  baseten: logo_baseten,
  cerebras: logo_cerebras,
  'cloudflare-ai-gateway': logo_cloudflare,
  'cloudflare-workers-ai': logo_workersai,
  deepseek: logo_deepseek,
  fireworks: logo_fireworks,
  'github-copilot': logo_githubcopilot,
  google: logo_google,
  'google-vertex': logo_vertexai,
  groq: logo_groq,
  huggingface: logo_huggingface,
  'kimi-coding': logo_kimi,
  meta: logo_meta,
  minimax: logo_minimax,
  'minimax-cn': logo_minimax,
  mistral: logo_mistral,
  moonshotai: logo_moonshot,
  'moonshotai-cn': logo_moonshot,
  nvidia: logo_nvidia,
  openai: logo_openai,
  'openai-codex': logo_codex,
  opencode: logo_opencode,
  'opencode-go': logo_opencode,
  openrouter: logo_openrouter,
  'qwen-token-plan': logo_qwen,
  'qwen-token-plan-cn': logo_qwen,
  'qwen-token-plan-individual': logo_qwen,
  together: logo_together,
  'vercel-ai-gateway': logo_vercel,
  xai: logo_xai,
  xiaomi: logo_xiaomimimo,
  'xiaomi-token-plan-ams': logo_xiaomimimo,
  'xiaomi-token-plan-cn': logo_xiaomimimo,
  'xiaomi-token-plan-sgp': logo_xiaomimimo,
  zai: logo_zai,
  'zai-coding-cn': logo_zai,
}

/** `provider`: a pi-ai provider id; any other value shows the initial of `name`. */
export function ProviderLogo(props: { provider: string; name: string }) {
  const url = LOGOS[props.provider]
  if (!url) {
    return (
      <span className="provider-logo provider-initial" aria-hidden="true">
        {props.name.charAt(0).toUpperCase()}
      </span>
    )
  }
  return (
    <span
      className="provider-logo"
      aria-hidden="true"
      style={{ maskImage: `url("${url}")`, WebkitMaskImage: `url("${url}")` }}
    />
  )
}
