# Anthropic：AI Agent 评估指南（中英双语）

> 原文：Demystifying evals for AI agents — Anthropic
> 作者：Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, Jiri De Jonghe

---

## 中文总结

本文是 Anthropic 发布的关于 AI Agent 评估（evals）的系统性指南，旨在帮助开发团队从零开始构建可靠的评估体系。文章首先指出，良好的评估能帮助团队更自信地发布 AI Agent——没有评估，团队会陷入被动的修复循环，修一个 bug 引入另一个；有了评估，问题和行为变化在影响用户之前就变得可见。

文章定义了评估的基本结构：给 AI 一个输入，然后对输出施加评分逻辑来衡量成功。Agent 评估比传统单轮评估复杂得多，因为 Agent 会跨多轮使用工具、修改状态并自适应——错误会传播和累积。文章区分了两类评估：**能力评估**（"Agent 能做好什么"，起始通过率应低，给团队一个攀登的坡）和**回归评估**（"Agent 是否仍能处理所有以前的任务"，通过率应接近100%）。

文章按 Agent 类型给出了具体评估方法：**编码 Agent** 依赖确定性评分器（单元测试是否通过），辅以 LLM 评分器评估代码质量；**对话 Agent** 需要验证端态结果和交互质量，常需第二个 LLM 模拟用户；**研究 Agent** 因质量标准因任务而异，需组合落地性检查、覆盖度检查和来源质量检查；**计算机使用 Agent** 需在真实或沙箱环境中运行，通过 URL 和页面状态检查验证。

文章还讨论了非确定性问题，引入了两个关键指标：**pass@k**（k 次尝试中至少一次成功的概率，适用于"一次成功就够"的场景）和 **pass^k**（k 次全部成功的概率，适用于需要一致性的场景）。

在"从零到一"路线图中，文章提出了 8 个步骤：(0) 尽早开始，20-50 个任务即可起步；(1) 从手动测试中提取；(2) 编写无歧义任务并配参考解；(3) 构建均衡的问题集；(4) 搭建稳定的评估环境；(5) 慎重设计评分器，优先用确定性评分器，必要时用 LLM 评分器，对路径不要过于死板；(6) 阅读转录记录以验证评分器有效性；(7) 监控评估饱和度；(8) 通过开放贡献和持续维护保持评估集健康。

文章强调**评估驱动开发**的理念：在 Agent 能力达到之前就先构建评估来定义预期行为，然后迭代直到 Agent 表现良好。评估还能加速新模型采用——有评估的团队可以在几天内切换到新模型，而没有评估的团队需要数周。最后，文章指出自动评估只是理解 Agent 性能的方法之一，完整的图景还需要生产监控、用户反馈、A/B 测试和人工审查。

---

## Introduction

### English

Good evaluations help teams ship AI agents more confidently. Without them, it's easy to get stuck in reactive loops—catching issues only in production, where fixing one failure creates others. Evals make problems and behavioral changes visible before they affect users, and their value compounds over the lifecycle of an agent.

As we described in Building effective agents, agents operate over many turns: calling tools, modifying state, and adapting based on intermediate results. These same capabilities that make AI agents useful—autonomy, intelligence, and flexibility—also make them harder to evaluate.

Through our internal work and with customers at the frontier of agent development, we've learned how to design more rigorous and useful evals for agents. Here's what's worked across a range of agent architectures and use cases in real-world deployment.

### 中文翻译

良好的评估能帮助团队更自信地发布 AI Agent。没有评估，团队很容易陷入被动的循环——只在生产环境中发现问题，而修复一个失败又可能引入另一个。评估让问题和行为变化在影响用户之前就变得可见，而且其价值在 Agent 生命周期中会不断累积。

正如我们在《构建有效 Agent》中所述，Agent 跨多轮运行：调用工具、修改状态、根据中间结果自适应。让 AI Agent 有用的这些能力——自主性、智能和灵活性——也使它们更难被评估。

通过我们的内部工作以及与前沿 Agent 开发客户的合作，我们学会了如何为 Agent 设计更严格、更有用的评估。以下是我们在各种 Agent 架构和实际部署场景中验证有效的经验。

---

## The structure of an evaluation

### English

An evaluation ("eval") is a test for an AI system: give an AI an input, then apply grading logic to its output to measure success. In this post, we focus on automated evals that can be run during development without real users.

Single-turn evaluations are straightforward: a prompt, a response, and grading logic. For earlier LLMs, single-turn, non-agentic evals were the main evaluation method. As AI capabilities have advanced, multi-turn evaluations have become increasingly common.

Agent evaluations are even more complex. Agents use tools across many turns, modifying state in the environment and adapting as they go—which means mistakes can propagate and compound. Frontier models can also find creative solutions that surpass the limits of static evals. For instance, Opus 4.5 solved a τ²-bench problem about booking a flight by discovering a loophole in the policy. It "failed" the evaluation as written, but actually came up with a better solution for the user.

When building agent evaluations, we use the following definitions:

### 中文翻译

评估（"eval"）是对 AI 系统的测试：给 AI 一个输入，然后对其输出施加评分逻辑来衡量成功。本文聚焦于可在开发阶段无需真实用户即可运行的自动化评估。

单轮评估很简单：一个提示、一个响应、一套评分逻辑。对于早期的大语言模型，单轮、非 Agent 式的评估是主要的评估方法。随着 AI 能力的进步，多轮评估变得越来越普遍。

Agent 评估更为复杂。Agent 跨多轮使用工具，在环境中修改状态并自适应——这意味着错误会传播和累积。前沿模型还能找到超越静态评估限制的创造性解决方案。例如，Opus 4.5 在 τ²-bench 中解决了一个关于预订航班的问题，它发现了政策中的一个漏洞。按评估设定的规则它"失败"了，但实际上为用户提出了一个更好的解决方案。

在构建 Agent 评估时，我们使用以下定义：

---

## Why build evaluations?

### English

When teams first start building agents, they can get surprisingly far through a combination of manual testing, dogfooding, and intuition. More rigorous evaluation may even seem like overhead that slows down shipping. But after the early prototyping stages, once an agent is in production and has started scaling, building without evals starts to break down.

The breaking point often comes when users report the agent feels worse after changes, and the team is "flying blind" with no way to verify except to guess and check. Absent evals, debugging is reactive: wait for complaints, reproduce manually, fix the bug, and hope nothing else regressed. Teams can't distinguish real regressions from noise, automatically test changes against hundreds of scenarios before shipping, or measure improvements.

We've seen this progression play out many times. For instance, Claude Code started with fast iteration based on feedback from Anthropic employees and external users. Later, we added evals—first for narrow areas like conciseness and file edits, and then for more complex behaviors like over-engineering. These evals helped identify issues, guide improvements, and focus research-product collaborations. Combined with production monitoring, A/B tests, user research, and more, evals provide signals to continue improving Claude Code as it scales.

Writing evals is useful at any stage in the agent lifecycle. Early on, evals force product teams to specify what success means for the agent, while later they help uphold a consistent quality bar.

### 中文翻译

当团队刚开始构建 Agent 时，通过手动测试、内部试用和直觉的组合，他们能走得相当远。更严格的评估甚至可能被视为拖慢发布速度的开销。但在早期原型阶段之后，一旦 Agent 上线并开始扩展，没有评估的开发就开始出问题了。

转折点往往出现在用户反馈 Agent 在改动后变差了，而团队"盲飞"——除了猜测和验证之外没有办法确认。没有评估，调试是被动的：等投诉、手动复现、修 bug、祈祷没有引入其他回归。团队无法区分真正的回归和噪声，无法在发布前针对数百个场景自动测试变更，也无法衡量改进。

我们见过这一进程反复上演。例如，Claude Code 起步时基于 Anthropic 员工和外部用户的反馈快速迭代。后来我们加入了评估——先从简洁性和文件编辑等窄领域开始，然后扩展到过度工程等更复杂的行为。这些评估帮助识别问题、指导改进并聚焦研究-产品协作。结合生产监控、A/B 测试、用户研究等，评估为 Claude Code 的持续改进提供了信号，助其随规模增长不断优化。

在 Agent 生命周期的任何阶段编写评估都有用。早期，评估迫使产品团队明确"成功"对 Agent 意味着什么；后期则帮助维持一致的质量标准。

---

### English

Descript's agent helps users edit videos, so they built evals around three dimensions of a successful editing workflow: don't break things, do what I asked, and do it well. They evolved from manual grading to LLM graders with criteria defined by the product team and periodic human calibration, and now regularly run two separate suites for quality benchmarking and regression testing. The Bolt AI team started building evals later, after they already had a widely used agent. In 3 months, they built an eval system that runs their agent and grades outputs with static analysis, uses browser agents to test apps, and employs LLM judges for behaviors like instruction following.

Some teams create evals at the start of development; others add them once at scale when evals become a bottleneck for improving the agent. Evals are especially useful at the start of agent development to explicitly encode expected behavior. Two engineers reading the same initial spec could come away with different interpretations on how the AI should handle edge cases. An eval suite resolves this ambiguity. Regardless of when they're created, evals help accelerate development.

### 中文翻译

Descript 的 Agent 帮助用户编辑视频，因此他们围绕成功编辑工作流的三个维度构建了评估：不破坏已有内容、按要求执行、并且做好。他们从手动评分发展到由产品团队定义标准的 LLM 评分器，并定期进行人工校准，现在常规运行两套独立的测试——一个用于质量基准，一个用于回归测试。Bolt AI 团队在已有广泛使用的 Agent 之后才开始构建评估。在 3 个月内，他们搭建了评估系统：用静态分析对 Agent 输出评分，用浏览器 Agent 测试应用，并用 LLM 评判器评估指令遵循等行为。

有些团队在开发初期就创建评估；另一些则等到规模扩大、评估成为改进瓶颈时才加入。在 Agent 开发初期，评估对于明确编码预期行为特别有用。两个工程师阅读同一份初始规格说明，可能对 AI 应如何处理边缘情况得出不同的理解。评估套件消除了这种歧义。无论何时创建，评估都有助于加速开发。

---

### English

Evals also shape how quickly you can adopt new models. When more powerful models come out, teams without evals face weeks of testing while competitors with evals can quickly determine the model's strengths, tune their prompts, and upgrade in days.

Once evals exist, you get baselines and regression tests for free: latency, token usage, cost per task, and error rates can be tracked on a static bank of tasks. Evals can also become the highest-bandwidth communication channel between product and research teams, defining metrics researchers can optimize against. Clearly, evals have wide-ranging benefits beyond tracking regressions and improvements. Their compounding value is easy to miss given that costs are visible upfront while benefits accumulate later.

### 中文翻译

评估还影响你采用新模型的速度。当更强大的模型发布时，没有评估的团队面临数周的测试，而拥有评估的竞争对手可以快速确定模型的优势、调整提示词，并在几天内完成升级。

一旦评估存在，你就免费获得了基线和回归测试：延迟、token 用量、每任务成本和错误率都可以在静态任务集上跟踪。评估还可以成为产品团队和研究团队之间最高带宽的沟通渠道，定义研究人员可以优化的指标。显然，评估的好处远不止于跟踪回归和改进。其累积价值容易被忽视——因为成本是前置可见的，而收益是后续累积的。

---

## How to evaluate AI agents

### English

We see several common types of agents deployed at scale today, including coding agents, research agents, computer use agents, and conversational agents. Each type may be deployed across a wide variety of industries, but they can be evaluated using similar techniques. You don't need to invent an evaluation from scratch. The sections below describe proven techniques for several agent types. Use these methods as a foundation, then extend them to your domain.

### 中文翻译

我们观察到当今大规模部署的几种常见 Agent 类型，包括编码 Agent、研究 Agent、计算机使用 Agent 和对话 Agent。每种类型可能部署在各种行业中，但可以用相似的技术来评估。你不需要从零开始发明评估方法。以下章节描述了几种 Agent 类型的成熟评估技术。将这些方法作为基础，然后扩展到你的领域。

---

## Types of graders for agents

### English

Agent evaluations typically combine three types of graders: code-based, model-based, and human. Each grader evaluates some portion of either the transcript or the outcome. An essential component of effective evaluation design is to choose the right graders for the job.

For each task, scoring can be weighted (combined grader scores must hit a threshold), binary (all graders must pass), or a hybrid.

### 中文翻译

Agent 评估通常结合三种类型的评分器：基于代码的、基于模型的和人工的。每个评分器评估转录记录或结果的某一部分。有效评估设计的一个关键要素是为工作选择合适的评分器。

对于每个任务，评分可以是加权式（组合评分器分数须达到阈值）、二值式（所有评分器都须通过）或混合式。

---

## Capability vs. regression evals

### English

Capability or "quality" evals ask, "What can this agent do well?" They should start at a low pass rate, targeting tasks the agent struggles with and giving teams a hill to climb.

Regression evals ask, "Does the agent still handle all the tasks it used to?" and should have a nearly 100% pass rate. They protect against backsliding, as a decline in score signals that something is broken and needs to be improved. As teams hill-climb on capability evals, it's important to also run regression evals to make sure changes don't cause issues elsewhere.

After an agent is launched and optimized, capability evals with high pass rates can "graduate" to become a regression suite that is run continuously to catch any drift. Tasks that once measured "Can we do this at all?" then measure "Can we still do this reliably?"

### 中文翻译

能力评估或"质量"评估问的是："这个 Agent 能做好什么？"它们的起始通过率应较低，瞄准 Agent 棘手的任务，给团队一个攀登的坡。

回归评估问的是："Agent 是否仍能处理以前的所有任务？"它们的通过率应接近 100%。它们防止倒退——分数下降意味着出了问题需要改进。当团队在能力评估上攀登时，同时运行回归评估很重要，以确保变更不会在其他地方引发问题。

在 Agent 发布并优化后，高通过率的能力评估可以"毕业"成为回归套件，持续运行以捕捉任何漂移。曾经衡量"我们能否做到？"的任务，转而衡量"我们能否可靠地做到？"

---

## Evaluating coding agents

### English

Coding agents write, test, and debug code, navigating codebases and running commands much like a human developer. Effective evals for modern coding agents usually rely on well-specified tasks, stable test environments, and thorough tests for the generated code.

Deterministic graders are natural for coding agents because software is generally straightforward to evaluate: does the code run and do the tests pass? Two widely used coding agent benchmarks, SWE-bench Verified and Terminal-Bench, follow this approach. SWE-bench Verified gives agents GitHub issues from popular Python repositories and grades solutions by running the test suite; a solution passes only if it fixes the failing tests without breaking existing ones. LLMs have progressed from 40% to >80% on this eval in just one year. Terminal-Bench takes a different track: it tests end-to-end technical tasks, such as building a Linux kernel from source or training an ML model.

Once you have a set of pass-or-fail tests for validating the key outcomes of a coding task, it's often useful to also grade the transcript. For instance, heuristics-based code quality rules can evaluate the generated code based on more than passing tests, and model-based graders with clear rubrics can assess behaviors like how the agent calls tools or interacts with the user.

### 中文翻译

编码 Agent 编写、测试和调试代码，像人类开发者一样导航代码库和运行命令。现代编码 Agent 的有效评估通常依赖于明确定义的任务、稳定的测试环境和对生成代码的全面测试。

确定性评分器对编码 Agent 来说很自然，因为软件评估通常很简单：代码能运行吗？测试通过吗？两个广泛使用的编码 Agent 基准——SWE-bench Verified 和 Terminal-Bench——都采用这种方法。SWE-bench Verified 给 Agent 来自流行 Python 仓库的 GitHub issue，通过运行测试套件来评分；只有修复了失败的测试且不破坏已有测试的方案才算通过。在这一评估上，大语言模型仅用一年时间就从 40% 提升到了 80% 以上。Terminal-Bench 则走了另一条路线：它测试端到端技术任务，如从源码构建 Linux 内核或训练 ML 模型。

一旦你有了验证编码任务关键结果的通过/失败测试集，对转录记录进行评分通常也很有用。例如，基于启发式的代码质量规则可以在测试通过之外评估生成代码，而具有清晰评分标准的基于模型的评分器可以评估 Agent 调用工具或与用户交互的行为方式。

---

### English

**Example: Theoretical evaluation for a coding agent**

Consider a coding task where the agent must fix an authentication bypass vulnerability. As shown in the illustrative YAML file below, one could evaluate this agent using both graders and metrics.

```yaml
task:
  id: "fix-auth-bypass_1"
  desc: "Fix authentication bypass when password field is empty and ..."
  graders:
    - type: deterministic_tests
      required: [test_empty_pw_rejected.py, test_null_pw_rejected.py]
    - type: llm_rubric
      rubric: prompts/code_quality.md
    - type: static_analysis
      commands: [ruff, mypy, bandit]
    - type: state_check
      expect:
        security_logs: {event_type: "auth_blocked"}
    - type: tool_calls
      required:
        - {tool: read_file, params: {path: "src/auth/*"}}
        - {tool: edit_file}
        - {tool: run_tests}
  tracked_metrics:
    - type: transcript
      metrics: [n_turns, n_toolcalls, n_total_tokens]
    - type: latency
      metrics: [time_to_first_token, output_tokens_per_sec, time_to_last_token]
```

Note that this example showcases the full range of available graders for illustration. In practice, coding evaluations typically rely on unit tests for correctness verification and an LLM rubric for assessing overall code quality, with additional graders and metrics added only as needed.

### 中文翻译

**示例：编码 Agent 的理论评估**

考虑一个编码任务，Agent 必须修复认证绕过漏洞。如下面示例 YAML 文件所示，可以同时使用评分器和指标来评估这个 Agent。

```yaml
task:
  id: "fix-auth-bypass_1"
  desc: "修复密码字段为空时的认证绕过漏洞..."
  graders:
    - type: deterministic_tests
      required: [test_empty_pw_rejected.py, test_null_pw_rejected.py]
    - type: llm_rubric
      rubric: prompts/code_quality.md
    - type: static_analysis
      commands: [ruff, mypy, bandit]
    - type: state_check
      expect:
        security_logs: {event_type: "auth_blocked"}
    - type: tool_calls
      required:
        - {tool: read_file, params: {path: "src/auth/*"}}
        - {tool: edit_file}
        - {tool: run_tests}
  tracked_metrics:
    - type: transcript
      metrics: [n_turns, n_toolcalls, n_total_tokens]
    - type: latency
      metrics: [time_to_first_token, output_tokens_per_sec, time_to_last_token]
```

注意，此示例为说明目的展示了全部可用评分器。实际中，编码评估通常依赖单元测试验证正确性，加上 LLM 评分标准评估整体代码质量，其他评分器和指标仅在需要时添加。

---

## Evaluating conversational agents

### English

Conversational agents interact with users in domains like support, sales, or coaching. Unlike traditional chatbots, they maintain state, use tools, and take actions mid-conversation. While coding and research agents can also involve many turns of interaction with the user, conversational agents present a distinct challenge: the quality of the interaction itself is part of what you're evaluating. Effective evals for conversational agents usually rely on verifiable end-state outcomes and rubrics that capture both task completion and interaction quality. Unlike most other evals, they often require a second LLM to simulate the user. We use this approach in our alignment auditing agents to stress-test models through extended, adversarial conversations.

Success for conversational agents can be multidimensional: is the ticket resolved (state check), did it finish in <10 turns (transcript constraint), and was the tone appropriate (LLM rubric)? Two benchmarks that incorporate multidimensionality are τ-Bench and its successor, τ²-Bench. These simulate multi-turn interactions across domains like retail support and airline booking, where one model plays a user persona while the agent navigates realistic scenarios.

### 中文翻译

对话 Agent 在客服、销售或辅导等领域与用户交互。与传统聊天机器人不同，它们维护状态、使用工具并在对话中采取行动。虽然编码和研究 Agent 也可能涉及与用户的多轮交互，但对话 Agent 带来了独特的挑战：交互本身的质量就是你要评估的一部分。对话 Agent 的有效评估通常依赖可验证的端态结果和同时捕获任务完成度与交互质量的评分标准。与大多数其他评估不同，它们通常需要第二个 LLM 来模拟用户。我们在对齐审计 Agent 中使用了这种方法，通过长时间的对抗性对话来压力测试模型。

对话 Agent 的成功是多维的：工单是否已解决（状态检查）、是否在 10 轮内完成（转录约束）、语气是否恰当（LLM 评分标准）？两个体现多维性的基准是 τ-Bench 及其继任者 τ²-Bench。它们在零售客服和航空预订等领域模拟多轮交互，其中一个模型扮演用户角色，Agent 则在真实场景中导航。

---

### English

**Example: Theoretical evaluation for a conversational agent**

Consider a support task where the agent must handle a refund for a frustrated customer.

```yaml
graders:
  - type: llm_rubric
    rubric: prompts/support_quality.md
    assertions:
      - "Agent showed empathy for customer's frustration"
      - "Resolution was clearly explained"
      - "Agent's response grounded in fetch_policy tool results"
  - type: state_check
    expect:
      tickets: {status: resolved}
      refunds: {status: processed}
  - type: tool_calls
    required:
      - {tool: verify_identity}
      - {tool: process_refund, params: {amount: "<=100"}}
      - {tool: send_confirmation}
  - type: transcript
    max_turns: 10
  tracked_metrics:
    - type: transcript
      metrics: [n_turns, n_toolcalls, n_total_tokens]
    - type: latency
      metrics: [time_to_first_token, output_tokens_per_sec, time_to_last_token]
```

As in our coding agent example, this task showcases multiple grader types for illustration. In practice, conversational agent evaluations typically use model-based graders to assess both communication quality and goal completion, because many tasks—like answering a question—may have multiple "correct" solutions.

### 中文翻译

**示例：对话 Agent 的理论评估**

考虑一个客服任务，Agent 必须为一位沮丧的客户处理退款。

```yaml
graders:
  - type: llm_rubric
    rubric: prompts/support_quality.md
    assertions:
      - "Agent 对客户的沮丧表示了共情"
      - "解决方案有清晰的解释"
      - "Agent 的回复基于 fetch_policy 工具结果"
  - type: state_check
    expect:
      tickets: {status: resolved}
      refunds: {status: processed}
  - type: tool_calls
    required:
      - {tool: verify_identity}
      - {tool: process_refund, params: {amount: "<=100"}}
      - {tool: send_confirmation}
  - type: transcript
    max_turns: 10
  tracked_metrics:
    - type: transcript
      metrics: [n_turns, n_toolcalls, n_total_tokens]
    - type: latency
      metrics: [time_to_first_token, output_tokens_per_sec, time_to_last_token]
```

与编码 Agent 示例一样，此任务为说明目的展示了多种评分器类型。实际中，对话 Agent 评估通常使用基于模型的评分器来同时评估沟通质量和目标完成度，因为许多任务——如回答问题——可能有多种"正确"的解决方案。

---

## Evaluating research agents

### English

Research agents gather, synthesize, and analyze information, then produce outputs like an answer or report. Unlike coding agents where unit tests provide binary pass/fail signals, research quality can only be judged relative to the task. What counts as "comprehensive," "well-sourced," or even "correct" depends on context: a market scan, due diligence for an acquisition, and a scientific report each require different standards.

Research evals face unique challenges: experts may disagree on whether a synthesis is comprehensive, ground truth shifts as reference content changes constantly, and longer, more open-ended outputs create more room for mistakes. A benchmark like BrowseComp, for example, tests whether AI agents can find needles in haystacks across the open web—questions designed to be easy to verify but hard to solve.

One strategy to build research agent evals is to combine grader types. Groundedness checks verify that claims are supported by retrieved sources, coverage checks define key facts a good answer must include, and source quality checks confirm the consulted sources are authoritative, rather than simply the first retrieved. For tasks with objectively correct answers ("What was Company X's Q3 revenue?"), exact match works. An LLM can flag unsupported claims and gaps in coverage but also verify the open-ended synthesis for coherence and completeness.

Given the subjective nature of research quality, LLM-based rubrics should be frequently calibrated against expert human judgment to grade these agents effectively.

### 中文翻译

研究 Agent 收集、综合和分析信息，然后产出如答案或报告之类的输出。与编码 Agent 中单元测试提供二值通过/失败信号不同，研究质量只能相对于任务来评判。什么算"全面""来源充分"甚至"正确"取决于上下文：市场扫描、收购尽职调查和科学报告各自需要不同的标准。

研究评估面临独特挑战：专家可能对综合是否全面存在分歧，真实答案随着参考内容不断变化而漂移，更长、更开放式的输出也意味着更多出错的空间。例如 BrowseComp 基准测试 AI Agent 能否在开放网络中大海捞针——这些问题被设计为容易验证但难以解决。

构建研究 Agent 评估的一种策略是组合多种评分器类型。落地性检查验证声明是否有检索到的来源支持，覆盖度检查定义好答案必须包含的关键事实，来源质量检查确认参考来源是权威的而非仅是第一个检索到的。对于有客观正确答案的任务（"X 公司第三季度营收是多少？"），精确匹配有效。LLM 可以标记不受支持的声明和覆盖缺口，还可以验证开放式综合的连贯性和完整性。

鉴于研究质量的主观性，基于 LLM 的评分标准应频繁与专家人工判断进行校准，才能有效为这些 Agent 评分。

---

## Computer use agents

### English

Computer use agents interact with software through the same interface as humans—screenshots, mouse clicks, keyboard inputs, and scrolling—rather than through APIs or code execution. They can use any application with a graphical user interface (GUI), from design tools to legacy enterprise software. Evaluation requires running the agent in a real or sandboxed environment where it can use software applications and checking whether it achieved the intended outcome. For instance, WebArena tests browser-based tasks, using URL and page state checks to verify the agent navigated correctly, along with backend state verification for tasks that modify data (confirming an order was actually placed, not just that the confirmation page appeared). OSWorld extends this to full operating system control, with evaluation scripts that inspect diverse artifacts after task completion: file system state, application configs, database contents, and UI element properties.

Browser use agents require a balance between token efficiency and latency. DOM-based interactions execute quickly but consume many tokens, while screenshot-based interactions are slower but more token-efficient. For example, when asking Claude to summarize Wikipedia, it is more efficient to extract the text from the DOM. When finding a new laptop case on Amazon, it is more efficient to take screenshots (as extracting the entire DOM is token-intensive). In our Claude for Chrome product, we developed evals to check that the agent was selecting the right tool for each context. This enabled us to complete browser-based tasks faster and more accurately.

### 中文翻译

计算机使用 Agent 通过与人类相同的界面——截图、鼠标点击、键盘输入和滚动——与软件交互，而非通过 API 或代码执行。它们可以使用任何具有图形用户界面（GUI）的应用，从设计工具到传统企业软件。评估需要在真实或沙箱环境中运行 Agent，让它使用软件应用，然后检查是否达到了预期目标。例如，WebArena 测试基于浏览器的任务，使用 URL 和页面状态检查来验证 Agent 导航是否正确，对于修改数据的任务还有后端状态验证（确认订单确实已下，而非仅确认页面出现）。OSWorld 将此扩展到完整操作系统控制，评估脚本在任务完成后检查各种产物：文件系统状态、应用配置、数据库内容和 UI 元素属性。

浏览器使用 Agent 需要在 token 效率和延迟之间取得平衡。基于 DOM 的交互执行快但消耗大量 token，而基于截图的交互较慢但 token 效率更高。例如，让 Claude 总结维基百科时，从 DOM 提取文本更高效。而在亚马逊上找新笔记本电脑包时，截图更高效（因为提取整个 DOM 非常耗 token）。在 Claude for Chrome 产品中，我们开发了评估来检查 Agent 是否为每个上下文选择了正确的工具。这使我们能更快、更准确地完成浏览器任务。

---

## How to think about non-determinism in evaluations for agents

### English

Regardless of agent type, agent behavior varies between runs, which makes evaluation results harder to interpret than they first appear. Each task has its own success rate—maybe 90% on one task, 50% on another—and a task that passed on one eval run might fail on the next. Sometimes, what we want to measure is how often (what proportion of the trials) an agent succeeds for a task.

Two metrics help capture this nuance:

**pass@k** measures the likelihood that an agent gets at least one correct solution in k attempts. As k increases, pass@k score rises: more "shots on goal" means higher odds of at least 1 success. A score of 50% pass@1 means that a model succeeds at half the tasks in the eval on its first try. In coding, we're often most interested in the agent finding the solution on the first try—pass@1. In other cases, proposing many solutions is valid as long as one works.

**pass^k** measures the probability that all k trials succeed. As k increases, pass^k falls since demanding consistency across more trials is a harder bar to clear. If your agent has a 75% per-trial success rate and you run 3 trials, the probability of passing all three is (0.75)³ ≈ 42%. This metric especially matters for customer-facing agents where users expect reliable behavior every time.

Both metrics are useful, and which to use depends on product requirements: pass@k for tools where one success matters, pass^k for agents where consistency is essential.

### 中文翻译

无论 Agent 类型如何，Agent 的行为在不同运行之间会有变化，这使评估结果比初看时更难解读。每个任务都有自己的成功率——也许一个任务 90%，另一个 50%——一次评估中通过的任务下次可能失败。有时，我们想衡量的是 Agent 在多次尝试中成功的频率（比例）。

两个指标帮助捕捉这一微妙之处：

**pass@k** 衡量 Agent 在 k 次尝试中至少获得一个正确解的可能性。随着 k 增加，pass@k 分数上升：更多"射门"意味着至少一次成功的概率更高。50% 的 pass@1 意味着模型首次尝试就能成功完成评估中一半的任务。在编码领域，我们通常最关心 Agent 首次尝试就找到解——pass@1。在其他情况下，只要有一个方案可行，提出多个方案也是合理的。

**pass^k** 衡量 k 次尝试全部成功的概率。随着 k 增加，pass^k 下降，因为要求更多尝试间保持一致性是更高的门槛。如果你的 Agent 每次尝试成功率为 75%，运行 3 次尝试，三次全部通过的概率是 (0.75)³ ≈ 42%。这个指标对于面向用户的 Agent 尤为重要，因为用户每次都期望可靠的行为。

两个指标都有用，选择哪个取决于产品需求：pass@k 适用于"一次成功就够"的工具，pass^k 适用于"一致性至关重要"的 Agent。

---

## Going from zero to one: a roadmap to great evals for agents

### English

This section lays out our practical, field-tested advice for going from no evals to evals you can trust. Think of this as a roadmap for eval-driven agent development: define success early, measure it clearly, and iterate continuously.

### 中文翻译

本节列出我们经过实践检验的建议，帮助你从没有评估到拥有可以信赖的评估。将此视为评估驱动 Agent 开发的路线图：尽早定义成功、清晰衡量、持续迭代。

---

### Collect tasks for the initial eval dataset

#### English — Step 0. Start early

We see teams delay building evals because they think they need hundreds of tasks. In reality, 20-50 simple tasks drawn from real failures is a great start. After all, in early agent development, each change to the system often has a clear, noticeable impact, and this large effect size means small sample sizes suffice. More mature agents may need larger, more difficult evals to detect smaller effects, but it's best to take the 80/20 approach in the beginning. Evals get harder to build the longer you wait. Early on, product requirements naturally translate into test cases. Wait too long and you're reverse-engineering success criteria from a live system.

#### 中文翻译 — 步骤 0：尽早开始

我们看到团队因为觉得需要数百个任务而推迟构建评估。实际上，从真实失败中提取 20-50 个简单任务就是很好的起点。毕竟在 Agent 早期开发中，系统的每次改动通常都有明显的、可察觉的影响，这种大的效应量意味着小样本就够了。更成熟的 Agent 可能需要更大、更难的评估来检测更小的效应，但一开始最好采用 80/20 方法。评估等待越久越难构建。早期，产品需求自然会转化为测试用例。等太久你就得从线上系统逆向推导成功标准。

---

#### English — Step 1. Start with what you already test manually

Begin with the manual checks you run during development—the behaviors you verify before each release and common tasks end users try. If you're already in production, look at your bug tracker and support queue. Converting user-reported failures into test cases ensures your suite reflects actual usage; prioritizing by user impact helps you invest effort where it counts.

#### 中文翻译 — 步骤 1：从你已经在手动测试的内容开始

从你在开发中运行的手动检查开始——每次发布前验证的行为和终端用户常尝试的任务。如果你已经上线，查看 bug 跟踪器和客服工单队列。将用户报告的失败转化为测试用例，确保你的套件反映真实使用情况；按用户影响排序帮助你把精力投在最重要的地方。

---

#### English — Step 2: Write unambiguous tasks with reference solutions

Getting task quality right is harder than it seems. A good task is one where two domain experts would independently reach the same pass/fail verdict. Could they pass the task themselves? If not, the task needs refinement. Ambiguity in task specifications becomes noise in metrics. The same applies to criteria for model-based graders: vague rubrics produce inconsistent judgments.

Each task should be passable by an agent that follows instructions correctly. This can be subtle. For instance, auditing Terminal-Bench revealed that if a task asks the agent to write a script but doesn't specify a filepath, and the tests assume a particular filepath for the script, the agent might fail through no fault of its own. Everything the grader checks should be clear from the task description; agents shouldn't fail due to ambiguous specs. With frontier models, a 0% pass rate across many trials (i.e. 0% pass@100) is most often a signal of a broken task, not an incapable agent, and a sign to double-check your task specification and graders. For each task, it's useful to create a reference solution: a known working output that passes all graders. This proves that the task is solvable and verifies graders are correctly configured.

#### 中文翻译 — 步骤 2：编写无歧义的任务并配参考解

把任务质量做好比看起来难。一个好任务是两个领域专家能独立得出相同通过/失败判断的任务。他们自己能通过这个任务吗？如果不能，任务需要改进。任务规格中的歧义会变成指标中的噪声。基于模型的评分器的标准也一样：模糊的评分标准会导致不一致的判断。

每个任务都应该能被一个正确遵循指令的 Agent 通过。这有时很微妙。例如，审计 Terminal-Bench 时发现，如果一个任务要求 Agent 写一个脚本但没有指定文件路径，而测试假设脚本在特定路径，Agent 可能会因为非自身原因而失败。评分器检查的一切都应从任务描述中清晰可见；Agent 不应因规格模糊而失败。对于前沿模型，多次尝试中 0% 的通过率（即 0% pass@100）通常是任务有问题而非 Agent 能力不足的信号，需要复查任务规格和评分器。对每个任务，创建一个参考解很有用：一个能通过所有评分器的已知有效输出。这证明任务可解，并验证评分器配置正确。

---

#### English — Step 3: Build balanced problem sets

Test both the cases where a behavior should occur and where it shouldn't. One-sided evals create one-sided optimization. For instance, if you only test whether the agent searches when it should, you might end up with an agent that searches for almost everything. Try to avoid class-imbalanced evals. We learned this firsthand when building evals for web search in Claude.ai. The challenge was preventing the model from searching when it shouldn't, while preserving its ability to do extensive research when appropriate. The team built evals covering both directions: queries where the model should search (like finding the weather) and queries where it should answer from existing knowledge (like "who founded Apple?"). Striking the right balance between undertriggering (not searching when it should) or overtriggering (searching when it shouldn't) was difficult, and took many rounds of refinements to both the prompts and the eval. As more example problems come up, we continue to add to evals to improve our coverage.

#### 中文翻译 — 步骤 3：构建均衡的问题集

既要测试行为应该发生的情况，也要测试不应该发生的情况。单侧评估会导致单侧优化。例如，如果你只测试 Agent 是否在该搜索时搜索，你可能最终得到一个对什么都要搜索的 Agent。尽量避免类别不平衡的评估。我们在为 Claude.ai 构建网页搜索评估时深有体会。挑战在于防止模型在不该搜索时搜索，同时保留其在适当时进行深入研究的能力。团队构建了双向评估：应该搜索的查询（如查天气）和应该用已有知识回答的查询（如"谁创立了苹果公司？"）。在欠触发（该搜索时不搜索）和过触发（不该搜索时搜索）之间取得正确平衡很困难，需要对提示词和评估进行多轮优化。随着更多示例问题出现，我们持续向评估中添加内容以改进覆盖度。

---

### Design the eval harness and graders

#### English — Step 4: Build a robust eval harness with a stable environment

It's essential that the agent in the eval functions roughly the same as the agent used in production, and that the environment itself doesn't introduce further noise. Each trial should be "isolated" by starting from a clean environment. Unnecessary shared state between runs (leftover files, cached data, resource exhaustion) can cause correlated failures due to infrastructure flakiness rather than agent performance. Shared state can also artificially inflate performance. For example, in some internal evals we observed Claude gaining an unfair advantage on some tasks by examining the git history from previous trials. If multiple distinct trials fail because of the same limitation in the environment (like limited CPU memory), these trials are not independent because they're affected by the same factor, and the eval results become unreliable for measuring agent performance.

#### 中文翻译 — 步骤 4：搭建稳健的评估框架和稳定环境

评估中的 Agent 应与生产中的 Agent 大致相同地运行，环境本身不应引入更多噪声，这至关重要。每次试验应从干净环境开始以实现"隔离"。运行之间不必要的共享状态（残留文件、缓存数据、资源耗尽）可能因基础设施不稳定而非 Agent 性能导致关联性失败。共享状态也可能人为抬高性能。例如，在一些内部评估中，我们观察到 Claude 通过检查之前试验的 git 历史在某些任务上获得了不公平优势。如果多次独立试验因环境限制（如 CPU 内存不足）而失败，这些试验并非独立的——它们受同一因素影响——评估结果在衡量 Agent 性能方面变得不可靠。

---

#### English — Step 5: Design graders thoughtfully

As discussed above, great eval design involves choosing the best graders for the agent and the tasks. We recommend choosing deterministic graders where possible, LLM graders where necessary or for additional flexibility, and using human graders judiciously for additional validation.

There is a common instinct to check that agents followed very specific steps like a sequence of tool calls in the right order. We've found this approach too rigid and results in overly brittle tests, as agents regularly find valid approaches that eval designers didn't anticipate. So as not to unnecessarily punish creativity, it's often better to grade what the agent produced, not the path it took.

For tasks with multiple components, build in partial credit. A support agent that correctly identifies the problem and verifies the customer but fails to process a refund is meaningfully better than one that fails immediately. It's important to represent this continuum of success in results.

Model grading often takes careful iteration to validate accuracy. LLM-as-judge graders should be closely calibrated with human experts to gain confidence that there is little divergence between the human grading and model grading. To avoid hallucinations, give the LLM a way out, like providing an instruction to return "Unknown" when it doesn't have enough information. It can also help to create clear, structured rubrics to grade each dimension of a task, and then grade each dimension with an isolated LLM-as-judge rather than using one to grade all dimensions. Once the system is robust, it's sufficient to use human review only occasionally.

#### 中文翻译 — 步骤 5：慎重设计评分器

如上所述，优秀的评估设计涉及为 Agent 和任务选择最佳评分器。我们建议尽可能选择确定性评分器，在必要时或需要额外灵活性时用 LLM 评分器，并谨慎使用人工评分器进行补充验证。

一种常见直觉是检查 Agent 是否遵循了非常具体的步骤，如按正确顺序调用一系列工具。我们发现这种方法过于死板，导致测试过于脆弱，因为 Agent 经常会找到评估设计者未预料到的有效方案。为了不必要地惩罚创造力，通常更好的做法是评估 Agent 产出了什么，而非它走的路径。

对于有多个组件的任务，应设置部分得分。一个正确识别问题并验证了客户但未能处理退款的客服 Agent，明显优于一个立即失败的 Agent。在结果中体现这种成功连续性很重要。

模型评分通常需要仔细迭代来验证准确性。LLM 评判评分器应与人工专家密切校准，以确信人工评分和模型评分之间几乎没有分歧。为避免幻觉，给 LLM 一个退路，比如指示它在信息不足时返回"Unknown"。创建清晰、结构化的评分标准来评估任务的每个维度，然后用一个独立的 LLM 评判器评估每个维度（而非用一个评分器评估所有维度），这也很有帮助。系统稳健后，偶尔使用人工审查就够了。

---

#### English — (Grader pitfalls)

Some evaluations have subtle failure modes that result in low scores even with good agent performance, as the agent fails to solve tasks due to grading bugs, agent harness constraints, or ambiguity. Even sophisticated teams can miss these issues. For example, Opus 4.5 initially scored 42% on CORE-Bench, until an Anthropic researcher found multiple issues: rigid grading that penalized "96.12" when expecting "96.124991…", ambiguous task specs, and stochastic tasks that were impossible to reproduce exactly. After fixing bugs and using a less constrained scaffold, Opus 4.5's score jumped to 95%. Similarly, METR discovered several misconfigured tasks in their time horizon benchmark that asked agents to optimize to a stated score threshold, but the grading required exceeding that threshold. This penalized models like Claude for following the instructions, while models that ignored the stated goal received better scores. Carefully double-checking tasks and graders can help avoid these problems.

Make your graders resistant to bypasses or hacks. The agent shouldn't be able to easily "cheat" the eval. Tasks and graders should be designed so that passing genuinely requires solving the problem rather than exploiting unintended loopholes.

#### 中文翻译 —（评分器陷阱）

一些评估有微妙的失败模式，即使 Agent 性能良好也得低分，因为 Agent 因评分 bug、评估框架约束或歧义而无法解决任务。即使经验丰富的团队也可能遗漏这些问题。例如，Opus 4.5 在 CORE-Bench 上最初只得 42%，直到一位 Anthropic 研究员发现了多个问题：期望"96.124991…"时却因"96.12"而扣分的死板评分、模糊的任务规格，以及无法精确复现的随机任务。修复 bug 并使用更少约束的脚手架后，Opus 4.5 的分数跃升至 95%。类似地，METR 在其时间跨度基准测试中发现了几处配置错误：任务要求 Agent 优化到指定分数阈值，但评分要求超过该阈值。这惩罚了 Claude 等遵循指令的模型，而忽视既定目标的模型反而得了更高分。仔细复查任务和评分器可以避免这些问题。

让你的评分器能抵御绕过或黑客手段。Agent 不应能轻易"作弊"通过评估。任务和评分器应设计为：通过评估确实需要解决问题，而非利用意外的漏洞。

---

### Maintain and use the eval long-term

#### English — Step 6: Check the transcripts

You won't know if your graders are working well unless you read the transcripts and grades from many trials. At Anthropic, we invested in tooling for viewing eval transcripts and we regularly take the time to read them. When a task fails, the transcript tells you whether the agent made a genuine mistake or whether your graders rejected a valid solution. It also often surfaces key details about agent and eval behavior.

Failures should seem fair: it's clear what the agent got wrong and why. When scores don't climb, we need confidence that it's due to agent performance and not the eval. Reading transcripts is how you verify that your eval is measuring what actually matters, and is a critical skill for agent development.

#### 中文翻译 — 步骤 6：检查转录记录

除非你阅读多次试验的转录记录和评分，否则你不知道评分器是否运作良好。在 Anthropic，我们投入工具来查看评估转录记录，并定期花时间阅读。当任务失败时，转录记录告诉你 Agent 是犯了真正的错误，还是你的评分器拒绝了有效解。它还经常暴露关于 Agent 和评估行为的关键细节。

失败应该是公平的：清楚 Agent 错了什么以及为什么。当分数不上升时，我们需要确信是 Agent 性能问题而非评估问题。阅读转录记录是你验证评估确实在衡量真正重要之事的方式，也是 Agent 开发的关键技能。

---

#### English — Step 7: Monitor for capability eval saturation

An eval at 100% tracks regressions but provides no signal for improvement. Eval saturation occurs when an agent passes all of the solvable tasks, leaving no room for improvement. For instance, SWE-Bench Verified scores started at 30% this year, and frontier models are now nearing saturation at >80%. As evals approach saturation, progress will also slow, as only the most difficult tasks remain. This can make results deceptive, as large capability improvements appear as small increases in scores. For example, the code review startup Qodo was initially unimpressed by Opus 4.5 because their one-shot coding evals didn't capture the gains on longer, more complex tasks. In response, they developed a new agentic eval framework, providing a much clearer picture of progress.

As a rule, we do not take eval scores at face value until someone digs into the details of the eval and reads some transcripts. If grading is unfair, tasks are ambiguous, valid solutions are penalized, or the harness constrains the model, the eval should be revised.

#### 中文翻译 — 步骤 7：监控能力评估饱和度

100% 的评估能跟踪回归但无法提供改进信号。评估饱和发生在 Agent 通过了所有可解任务、没有改进空间时。例如，SWE-Bench Verified 今年起始分数为 30%，前沿模型现已接近 80% 的饱和度。随着评估接近饱和，进展也会放缓，因为只剩最困难的任务。这可能使结果具有欺骗性——大的能力提升表现为分数的小幅增长。例如，代码审查初创公司 Qodo 最初对 Opus 4.5 不以为然，因为他们的单次编码评估未能捕捉到在更长、更复杂任务上的提升。作为回应，他们开发了一个新的 Agent 式评估框架，更清晰地展示了进展。

作为规则，在有人深入评估细节并阅读一些转录记录之前，我们不会按面值接受评估分数。如果评分不公平、任务有歧义、有效解被惩罚，或框架限制了模型，评估就应被修订。

---

#### English — Step 8: Keep evaluation suites healthy long-term through open contribution and maintenance

An eval suite is a living artifact that needs ongoing attention and clear ownership to remain useful.

At Anthropic, we experimented with various approaches to eval maintenance. What proved most effective was establishing dedicated evals teams to own the core infrastructure, while domain experts and product teams contribute most eval tasks and run the evaluations themselves.

For AI product teams, owning and iterating on evaluations should be as routine as maintaining unit tests. Teams can waste weeks on AI features that "work" in early testing but fail to meet unstated expectations that a well-designed eval would have surfaced early. Defining eval tasks is one of the best ways to stress-test whether the product requirements are concrete enough to start building.

We recommend practicing eval-driven development: build evals to define planned capabilities before agents can fulfill them, then iterate until the agent performs well. Internally, we often build features that work "well enough" today but are bets on what models can do in a few months. Capability evals that start at a low pass rate make this visible. When a new model drops, running the suite quickly reveals which bets paid off.

The people closest to product requirements and users are best positioned to define success. With current model capabilities, product managers, customer success managers, or salespeople can use Claude Code to contribute an eval task as a PR—let them! Or, even better, actively enable them.

#### 中文翻译 — 步骤 8：通过开放贡献和持续维护保持评估集长期健康

评估集是一个活件，需要持续关注和明确的所有权才能保持有用。

在 Anthropic，我们尝试了各种评估维护方法。最有效的是建立专门的评估团队来拥有核心基础设施，而领域专家和产品团队贡献大部分评估任务并自行运行评估。

对于 AI 产品团队，拥有和迭代评估应该像维护单元测试一样常规。团队可能浪费数周在早期测试"能用"但无法满足未言明期望的 AI 功能上——一个设计良好的评估本应在早期就发现这些问题。定义评估任务是压力测试产品需求是否足够具体到可以开始构建的最佳方式之一。

我们建议实践评估驱动开发：在 Agent 能够实现之前，先构建评估来定义计划中的能力，然后迭代直到 Agent 表现良好。在内部，我们经常构建今天"足够好"的功能，但这些是对模型几个月后能做什么的押注。起始通过率低的能力评估让这一点变得可见。当新模型发布时，运行评估集可以快速揭示哪些押注得到了回报。

最接近产品需求和用户的人最适合定义成功。以当前模型能力，产品经理、客户成功经理或销售人员可以用 Claude Code 以 PR 形式贡献评估任务——让他们这样做！甚至更好，主动赋能他们。

---

## How evals fit with other methods for a holistic understanding of agents

### English

Automated evaluations can be run against an agent in thousands of tasks without deploying to production or affecting real users. But this is just one of many ways to understand agent performance. A complete picture includes production monitoring, user feedback, A/B testing, manual transcript review, and systematic human evaluation.

These methods map to different stages of agent development. Automated evals are especially useful pre-launch and in CI/CD, running on each agent change and model upgrade as the first line of defense against quality problems. Production monitoring kicks in post-launch to detect distribution drift and unanticipated real-world failures. A/B testing validates significant changes once you have sufficient traffic. User feedback and transcript review are ongoing practices to fill the gaps: triage feedback constantly, sample transcripts to read weekly, and dig deeper as needed. Reserve systematic human studies for calibrating LLM graders or evaluating subjective outputs where human consensus serves as the reference standard.

The most effective teams combine these methods: automated evals for fast iteration, production monitoring for ground truth, and periodic human review for calibration.

### 中文翻译

自动评估可以在数千个任务上对 Agent 进行而无需部署到生产环境或影响真实用户。但这只是理解 Agent 性能的众多方法之一。完整的图景包括生产监控、用户反馈、A/B 测试、人工转录审查和系统性人工评估。

这些方法对应 Agent 开发的不同阶段。自动评估在上线前和 CI/CD 中尤为有用，在每次 Agent 变更和模型升级时运行，作为质量问题的第一道防线。生产监控在上线后启动，检测分布漂移和未预料的现实失败。A/B 测试在有足够流量后验证重大变更。用户反馈和转录审查是填补空白的持续实践：不断分类反馈、每周抽样转录记录阅读、按需深入挖掘。系统性人工研究则保留用于校准 LLM 评分器或评估以人工共识为参考标准的主观输出。

最有效的团队结合这些方法：自动评估用于快速迭代，生产监控用于真实情况，定期人工审查用于校准。

---

## Conclusion

### English

Teams without evals get bogged down in reactive loops—fixing one failure, creating another, unable to distinguish real regressions from noise. Teams that invest early find the opposite: development accelerates as failures become test cases, test cases prevent regressions, and metrics replace guesswork. Evals give the whole team a clear hill to climb, turning "the agent feels worse" into something actionable. The value compounds, but only if you treat evals as a core component, not an afterthought.

The patterns vary by agent type, but the fundamentals described here are constant. Start early and don't wait for the perfect suite. Source realistic tasks from the failures you see. Define unambiguous, robust success criteria. Design graders thoughtfully and combine multiple types. Make sure the problems are hard enough for the model. Iterate on the evaluations to improve their signal-to-noise ratio. Read the transcripts!

AI agent evaluation is still a nascent, fast-evolving field. As agents take on longer tasks, collaborate in multi-agent systems, and handle increasingly subjective work, we will need to adapt our techniques. We'll keep sharing best practices as we learn more.

### 中文翻译

没有评估的团队陷入被动的循环——修一个失败、引入另一个，无法区分真正的回归和噪声。早期投入的团队发现恰恰相反：随着失败变成测试用例、测试用例防止回归、指标取代猜测，开发加速了。评估给整个团队一个明确的攀登坡，将"Agent 变差了"变成可行动的事项。其价值会累积，但前提是你把评估当作核心组件，而非事后补充。

模式因 Agent 类型而异，但此处描述的基本原则是恒定的。尽早开始，不要等待完美的套件。从你看到的失败中提取真实任务。定义无歧义、稳健的成功标准。慎重设计评分器并组合多种类型。确保问题对模型来说足够难。迭代评估以提高信噪比。阅读转录记录！

AI Agent 评估仍是一个新兴的、快速发展的领域。随着 Agent 承担更长任务、在多 Agent 系统中协作、处理日益主观的工作，我们需要调整技术。我们将随着了解更多而持续分享最佳实践。

---

## Acknowledgements

### English

Written by Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, and Jiri De Jonghe. We're also grateful to David Hershey, Gian Segato, Mike Merrill, Alex Shaw, Nicholas Carlini, Ethan Dixon, Pedram Navid, Jake Eaton, Alyssa Baum, Lina Tawfik, Karen Zhou, Alexander Bricken, Sam Kennedy, Robert Ying, and others for their contributions. Special thanks to the customers and partners we have learned from through collaborating on evals, including iGent, Cognition, Bolt, Sierra, Vals.ai, Macroscope, PromptLayer, Stripe, Shopify, the Terminal Bench team, and more. This work reflects the collective efforts of several teams who helped develop the practice of evaluations at Anthropic.

### 中文翻译

由 Mikaela Grace、Jeremy Hadfield、Rodrigo Olivares 和 Jiri De Jonghe 撰写。我们还感谢 David Hershey、Gian Segato、Mike Merrill、Alex Shaw、Nicholas Carlini、Ethan Dixon、Pedram Navid、Jake Eaton、Alyssa Baum、Lina Tawfik、Karen Zhou、Alexander Bricken、Sam Kennedy、Robert Ying 等人的贡献。特别感谢我们通过评估合作学习的客户和合作伙伴，包括 iGent、Cognition、Bolt、Sierra、Vals.ai、Macroscope、PromptLayer、Stripe、Shopify、Terminal Bench 团队等。这项工作反映了多个团队共同努力发展 Anthropic 评估实践的结果。

---

## Appendix: Eval frameworks

### English

Several open-source and commercial frameworks can help teams implement agent evaluations without building infrastructure from scratch. The right choice depends on your agent type, existing stack, and whether you need offline evaluation, production observability, or both.

Harbor is designed for running agents in containerized environments, with infrastructure for running trials at scale across cloud providers and a standardized format for defining tasks and graders. Popular benchmarks like Terminal-Bench 2.0 ship through the Harbor registry, making it easy to run established benchmarks along with custom eval suites.

Braintrust is a platform that combines offline evaluation with production observability and experiment tracking—useful for teams that need to both iterate during development and monitor quality in production. Its `autoevals` library includes pre-built scorers for factuality, relevance, and other common dimensions.

LangSmith offers tracing, offline and online evaluations, and dataset management with tight integration into the LangChain ecosystem. Langfuse provides similar capabilities as a self-hosted open-source alternative for teams with data residency requirements.

Arize offers Phoenix, an open-source platform for LLM tracing, debugging, and offline or online evaluations, and AX, a SaaS offering that extends Phoenix for scale, optimization and monitoring.

Many teams combine multiple tools, roll their own eval framework, or just use simple evaluation scripts as a starting point. We find that while frameworks can be a valuable way to accelerate progress and standardize, they're only as good as the eval tasks you run through them. It's often best to quickly pick a framework that fits your workflow, then invest your energy in the evals themselves by iterating on high-quality test cases and graders.

### 中文翻译

几个开源和商业框架可以帮助团队实现 Agent 评估，无需从零搭建基础设施。正确的选择取决于你的 Agent 类型、现有技术栈，以及你需要的是离线评估、生产可观测性还是两者兼有。

Harbor 专为在容器化环境中运行 Agent 而设计，提供跨云服务商大规模运行试验的基础设施，以及定义任务和评分器的标准化格式。Terminal-Bench 2.0 等流行基准通过 Harbor 注册表发布，使运行既有基准和自定义评估套件变得容易。

Braintrust 是一个结合离线评估、生产可观测性和实验跟踪的平台——适合需要同时在开发中迭代和生产中监控质量的团队。其 `autoevals` 库包含事实性、相关性等常见维度的预构建评分器。

LangSmith 提供追踪、离线和在线评估以及数据集管理，与 LangChain 生态紧密集成。Langfuse 作为自托管开源替代方案，为有数据驻留要求的团队提供类似能力。

Arize 提供 Phoenix——一个用于 LLM 追踪、调试和离线/在线评估的开源平台，以及 AX——将 Phoenix 扩展至规模化、优化和监控的 SaaS 产品。

许多团队组合多种工具、自建评估框架，或仅用简单评估脚本作为起点。我们发现虽然框架可以加速进度和标准化，但它们的好坏取决于你通过它们运行的评估任务。通常最好快速选择一个适合你工作流的框架，然后通过迭代高质量测试用例和评分器，把精力投入到评估本身。
