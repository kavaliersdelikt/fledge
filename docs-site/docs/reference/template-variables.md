---
title: Template variable types
---

# Template variable types

Variables are declared in a [template](/panel/templates#variables) as a list of up to 40 definitions.

```json
{
  "key": "MAX_PLAYERS",
  "label": "Slots",
  "description": "How many players can join.",
  "type": "number",
  "min": 1,
  "max": 50,
  "userEditable": true,
  "required": true
}
```

## Common fields

| Field | Meaning |
| --- | --- |
| `key` | Environment variable name: capital letters, digits and underscores, starting with a letter or `_`, up to 64 characters. Unique per template |
| `label` | Shown in forms (up to 80 characters); defaults to the key |
| `description` | Help text (up to 300 characters) |
| `type` | `string`, `number`, `boolean` or `select` |
| `userEditable` | Whether owners may change it in the [startup panel](/panel/startup) |
| `required` | A value must be present |
| `secret` | Hidden from everyone but administrators |

## Types

| Type | Extra fields | Validation |
| --- | --- | --- |
| `string` | `pattern` (regular expression, up to 200 characters, matched with a time limit) | Must match `pattern` when given |
| `number` | `min`, `max` | Must be a number within the range |
| `boolean` | | `true` or `false`, shown as a switch |
| `select` | `options`: 1 to 60 of `{ "value", "label" }` | Must be one of the values |

Values are validated on the server every time they are saved; the form only helps. Names beginning with `RCON_` or holding passwords
are commonly marked `secret`. The legacy `editableVariables` list of names is still accepted and treated as plain editable text.
