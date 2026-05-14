---
name: omnivoice-voice-design
description: OmniVoice voice design instruct reference for pi-vo. Use when writing text for voice_say, specifying voice design parameters in ttsVoiceDesign config, or understanding valid voice design combinations.
---

# OmniVoice Voice Design

OmniVoice supports voice design via the `instruct` parameter (or `ttsVoiceDesign` config). Use comma-separated speaker attributes (English) or full-width commas (Chinese).

## Categories & Valid Values

Each category allows at most one attribute. Combine freely across categories.

### Gender

| English | Chinese |
|---------|---------|
| `male` | `男` |
| `female` | `女` |

### Age

| English | Chinese |
|---------|---------|
| `child` | `儿童` |
| `teenager` | `少年` |
| `young adult` | `青年` |
| `middle-aged` | `中年` |
| `elderly` | `老年` |

### Pitch

| English | Chinese |
|---------|---------|
| `very low pitch` | `极低音调` |
| `low pitch` | `低音调` |
| `moderate pitch` | `中音调` |
| `high pitch` | `高音调` |
| `very high pitch` | `极高音调` |

### Style

| English | Chinese |
|---------|---------|
| `whisper` | `耳语` |

### English Accent (English text only)

| Accent |
|--------|
| `american accent` |
| `british accent` |
| `australian accent` |
| `canadian accent` |
| `indian accent` |
| `chinese accent` |
| `korean accent` |
| `japanese accent` |
| `portuguese accent` |
| `russian accent` |

### Chinese Dialect (Chinese text only)

| Dialect |
|---------|
| `河南话` |
| `陕西话` |
| `四川话` |
| `贵州话` |
| `云南话` |
| `桂林话` |
| `济南话` |
| `石家庄话` |
| `甘肃话` |
| `宁夏话` |
| `青岛话` |
| `东北话` |

## Writing Instruct Strings

```
# English (comma + space)
"female, young adult, high pitch, british accent"

# Chinese (full-width comma)
"女，青年，高音调，四川话"

# Minimal
"female"
```

## Examples

```
female, young adult, high pitch
male, elderly, very low pitch, whisper
child, moderate pitch
female, british accent
```

## Non-Verbal Symbols

OmniVoice supports inline non-verbal symbols within the text:

| Tag | Use |
|-----|-----|
| `[laughter]` | Laughter sound |
| `[sigh]` | Sighing sound |
| `[confirmation-en]` | Confirming: "En" |
| `[question-en]` | Questioning: "En" |
| `[question-ah]` | Questioning: "Ah" |
| `[question-oh]` | Questioning: "Oh" |
| `[question-ei]` | Questioning: "Ei" |
| `[question-yi]` | Questioning: "Yi" |
| `[surprise-ah]` | Expressing surprise: "Ah" |
| `[surprise-oh]` | Expressing surprise: "Oh" |
| `[surprise-wa]` | Expressing surprise: "Wa" |
| `[surprise-yo]` | Expressing surprise: "Yo" |
| `[dissatisfaction-hnn]` | Dissatisfied sound: "Hnn" |

Example:
```
[laughter] You really got me. I didn't see that coming at all.
```