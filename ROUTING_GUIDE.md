# ASD v2.4.2 모델 라우팅 설정 가이드 (`routing.jsonc`)

ASD(Agent Swarm Director)는 작업 실행 방식에 따라 **`LIGHT` 모드(현재 하네스 내부 서브에이전트 위임)**와 **`HEAVY` 모드(외부 하네스 CLI 병렬 프로세스 스폰 & 블라인드 디베이트)**를 구분하여 모델을 라우팅합니다.

---

## 1. 설정 파일 위치 및 우선순위

ASD는 다음 순서로 `routing.jsonc`를 읽어 들입니다:

1. **프로젝트별 로컬 설정 (1순위)**: `<프로젝트 루트>/.asd/routing.jsonc`
   - 특정 프로젝트에서만 다른 모델/폴백 구성을 쓰고 싶을 때 생성합니다.
2. **사용자 글로벌 설정 (기본값)**: `~/.asd/routing.jsonc` (Windows: `C:\Users\<사용자>\.asd\routing.jsonc`)
   - 모든 프로젝트에 공통 적용되는 전역 설정입니다.

> [!IMPORTANT]
> `~/.asd/routing.jsonc`를 수정한 뒤에는 각 하네스(`~/.gemini/config/agents/`, `~/.claude/agents/`, `~/.config/opencode/agent/`, `~/.cursor/agents/`)의 서브에이전트 정의 파일에 모델 티어를 반영하기 위해 반드시 **`asd sync --force`**를 한 번 실행해 주세요.

---

## 2. `LIGHT` 모드 vs `HEAVY` 모드 라우팅 구조 한눈에 보기

| 구분 | `lightSubagents` (`LIGHT` 모드 전용) | `agents` & `categories` / `heavyRouting` (`HEAVY` 모드 전용) |
| :--- | :--- | :--- |
| **작동 시점** | 단일 하네스 내부 서브에이전트 위임 (`invoke_subagent`, `Task`, `task`), `PreToolUse` 모델 강제 치환(`overwrite`), `asd sync` 에이전트 파일 생성 | `asd dispatch --mode parallel_spawn` (외부 CLI 멀티프로세스 스폰), `asd debate` (크로스 하네스 토론) |
| **하네스 전환 여부** | **현재 실행 중인 하네스 고정** (예: Antigravity 안에서는 Antigravity 서브에이전트만 실행) | **하네스 간 교차 실행 가능** (예: 1순위 OpenCode 실패 시 2순위 Codex CLI로 폴백) |
| **모델 표기 형식** | 각 하네스가 인식하는 **네이티브 모델 티어/ID** (`flash_lite`, `flash`, `pro`, `haiku`, `sonnet`, `opus` 등) | 각 CLI의 `--model` 플래그에 전달할 **정식 모델 문자열** (`claude-sonnet-4-6`, `gpt-5-codex`, `glm-5` 등) |

---

## 3. `lightSubagents` 설정 방법 (`LIGHT` 모드 + Fallback 지정)

`lightSubagents`는 각 하네스(`antigravity`, `claude-code`, `opencode`, `codex`, `cursor`) 내부에서 5대 역할(`scout`, `worker`, `planner`, `architect`, `critic`) 및 기본 모델(`defaultModel`)이 사용할 모델과 **동일 하네스 내 폴백(Fallback) 모델 순서**를 정의합니다.

### 3.1. 지원하는 3가지 표기법 (혼용 가능)

각 역할(`worker`, `scout` 등)과 `defaultModel`에는 아래 3가지 방식 중 편한 방식을 자유롭게 쓸 수 있습니다:

1. **단일 문자열 표기 (1순위 모델만 지정)**
   ```jsonc
   "worker": "flash"
   ```
2. **배열 표기 (`[1순위 모델, 1차 폴백, 2차 폴백, ...]`)**
   ```jsonc
   "worker": ["flash", "flash_lite", "pro"]
   ```
3. **객체 표기 (`{ "model": "1순위", "fallbacks": ["1차 폴백", "2차 폴백"] }`)**
   ```jsonc
   "worker": { "model": "flash", "fallbacks": ["flash_lite", "pro"] }
   ```
4. **하네스 공통 폴백 (`"fallbacks"` 배열)**
   - 하네스 블록에 `"fallbacks": ["flash_lite"]`를 추가하면, 개별 역할의 폴백 목록 뒤에 자동으로 합쳐집니다(중복 제거).

---

### 3.2. 하네스별 허용 모델 티어 및 작성 예시

```jsonc
{
  "_asdVersion": "2.4.1",
  "lightSubagents": {
    // 1) Antigravity: 반드시 "flash_lite" | "flash" | "pro" 중 하나를 사용합니다.
    //    ("inherit"이나 "gemini-3.8-flash"를 적어도 ASD가 자동으로 위 3개 티어로 정규화하여
    //     부모 Gemini 4 Argon 주간 쿼터 고갈을 방지합니다.)
    "antigravity": {
      "scout": { "model": "flash_lite", "fallbacks": ["flash"] },
      "worker": { "model": "flash", "fallbacks": ["flash_lite", "pro"] },
      "planner": ["flash", "pro"],
      "architect": { "model": "pro", "fallbacks": ["flash"] },
      "critic": { "model": "pro", "fallbacks": ["flash"] },
      "defaultModel": "flash",
      "fallbacks": ["flash_lite"]
    },

    // 2) Claude Code: "haiku" | "sonnet" | "opus" (또는 정식 claude-* 모델명)
    "claude-code": {
      "scout": { "model": "haiku", "fallbacks": ["sonnet"] },
      "worker": { "model": "sonnet", "fallbacks": ["haiku", "opus"] },
      "planner": { "model": "sonnet", "fallbacks": ["opus"] },
      "architect": { "model": "opus", "fallbacks": ["sonnet"] },
      "critic": { "model": "opus", "fallbacks": ["sonnet"] },
      "defaultModel": "sonnet",
      "fallbacks": ["haiku"]
    },

    // 3) OpenCode: provider/model 형식 지원
    "opencode": {
      "scout": "nvidia/z-ai/glm-5.3-flash",
      "worker": {
        "model": "nvidia/z-ai/glm-5.3-flash",
        "fallbacks": ["nvidia/deepseek-ai/deepseek-v4.1-flash", "glm-5"]
      },
      "planner": "nvidia/z-ai/glm-5.3-flash",
      "architect": "nvidia/z-ai/glm-5.3-flash",
      "critic": "nvidia/z-ai/glm-5.3-flash",
      "defaultModel": "nvidia/z-ai/glm-5.3-flash",
      "fallbacks": ["glm-5"]
    },

    // 4) Codex CLI
    "codex": {
      "defaultModel": "gpt-6-luna",
      "fallbacks": ["gpt-6.1-sol"]
    },

    // 5) Cursor CLI
    "cursor": {
      "defaultModel": "claude-sonnet-4-6",
      "fallbacks": ["gpt-5.4"]
    }
  }
}
```

### 3.3. Antigravity에서 외부 플러그인 서브에이전트(`explore`, `sisyphus-junior` 등) 모델 오버라이드

Antigravity의 `PreToolUse` 훅은 `asd-*` 에이전트뿐만 아니라 OMO 등 외부 플러그인 서브에이전트를 `invoke_subagent`로 호출할 때도 `Model: "inherit"`을 가로채어 경량 티어로 자동 치환합니다.
특정 외부 서브에이전트 이름(`TypeName`)을 직접 매핑하고 싶다면 `lightSubagents.antigravity` 안에 그대로 키를 추가할 수 있습니다:

```jsonc
"antigravity": {
  "scout": "flash_lite",
  "worker": "flash",
  "explore": "flash_lite",
  "librarian": "flash_lite",
  "sisyphus-junior": ["flash", "flash_lite"],
  "oracle": "pro"
}
```

---

## 4. `HEAVY` 모드 설정 방법 (`agents` & `categories` 또는 `heavyRouting`)

외부 CLI를 멀티프로세스 + Git Worktree로 띄우는 `HEAVY` 모드(`asd dispatch --mode parallel_spawn` 및 `asd debate`)는 기존 `agents`와 `categories` 블록(또는 `heavyRouting: { agents, categories }` 래퍼)을 사용합니다.

- **`agents`**: 전문 역할(`planner`, `architect`, `worker`, `scout`, `critic`)별 1순위 하네스/모델 및 크로스 하네스 `fallbacks` 배열
- **`categories`**:
  - 도메인 카테고리: `visual-ui`, `design`, `research`, `writing`, `general`
  - 난이도 티어(`worker` + `general`일 때 사용): `low`, `medium`, `high`

```jsonc
{
  "agents": {
    "worker": {
      "harness": "opencode",
      "model": "nvidia/z-ai/glm-5.3-flash",
      "modelFamily": "glm",
      "fallbacks": [
        { "harness": "codex", "model": "gpt-6-luna", "modelFamily": "gpt" },
        { "harness": "claude-code", "model": "claude-sonnet-4-6", "modelFamily": "claude" }
      ]
    }
  }
}
```

---

## 5. 설정 변경 후 적용 및 확인 명령어

1. **전역 하네스 및 스탠드얼론 런타임 동기화**:
   ```bash
   asd sync --force
   ```
2. **현재 상태 및 진단 확인**:
   ```bash
   asd doctor
   ```
3. **웹 대시보드(`asd ui`)에서 시각적으로 확인/편집**:
   ```bash
   asd ui
   ```
   - 브라우저에서 **라우팅 편집** 버튼을 눌러 프로젝트별 `.asd/routing.jsonc`를 저장하거나, 서브에이전트 Inspector에서 **폴백 실행(`fallback`)** / **선택 실행(`custom`)**을 테스트할 수 있습니다.
