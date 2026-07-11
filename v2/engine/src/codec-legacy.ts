import {
  DomainMessage,
  DomainBlock,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  CodecError,
} from "./domain.js";

export function legacyToDomain(raw: unknown): DomainMessage {
  if (!isPlainObject(raw)) {
    throw new CodecError("Message must be an object");
  }

  const role = (raw as Record<string, unknown>).role;
  if (role !== "user" && role !== "assistant") {
    throw new CodecError(`Invalid role: ${role}`);
  }

  const content = (raw as Record<string, unknown>).content;
  if (typeof content === "string") {
    return { role, content } as DomainMessage;
  }

  if (!Array.isArray(content)) {
    throw new CodecError("Content must be string or array");
  }

  const blocks: DomainBlock[] = [];
  for (const block of content) {
    blocks.push(convertLegacyBlockToDomain(block));
  }

  return { role, content: blocks } as DomainMessage;
}

export function legacyListToDomain(raw: unknown[]): DomainMessage[] {
  if (!Array.isArray(raw)) {
    throw new CodecError("Expected array of messages");
  }
  return raw.map(legacyToDomain);
}

export function domainToLegacy(m: DomainMessage): Record<string, unknown> {
  const result: Record<string, unknown> = { role: m.role };

  if (typeof m.content === "string") {
    result.content = m.content;
  } else if (Array.isArray(m.content)) {
    result.content = m.content.map(convertDomainBlockToLegacy);
  }

  return result;
}

function convertLegacyBlockToDomain(block: unknown): DomainBlock {
  if (!isPlainObject(block)) {
    throw new CodecError("Block must be an object");
  }

  const b = block as Record<string, unknown>;
  const type = b.type;

  switch (type) {
    case "text": {
      if (typeof b.text !== "string") {
        throw new CodecError("Text block missing or invalid 'text' field");
      }
      return { type: "text", text: b.text } as TextBlock;
    }
    case "image": {
      const source = b.source as Record<string, unknown>;
      if (!isPlainObject(source)) {
        throw new CodecError("Image block missing 'source'");
      }
      if (typeof source.data !== "string" || typeof source.media_type !== "string") {
        throw new CodecError("Image source missing 'data' or 'media_type'");
      }
      return {
        type: "image",
        mediaType: source.media_type,
        base64Data: source.data,
      } as ImageBlock;
    }
    case "tool_use": {
      if (typeof b.id !== "string" || typeof b.name !== "string") {
        throw new CodecError("Tool use block missing 'id' or 'name'");
      }
      if (typeof b.input !== "object" || b.input === null || Array.isArray(b.input)) {
        throw new CodecError("Tool use block 'input' must be a plain object");
      }
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      } as ToolUseBlock;
    }
    case "tool_result": {
      if (typeof b.tool_use_id !== "string") {
        throw new CodecError("Tool result block missing 'tool_use_id'");
      }
      if (typeof b.content !== "string") {
        throw new CodecError("Tool result block missing 'content'");
      }
      let isError = false;
      if (b.is_error !== undefined) {
        if (typeof b.is_error !== "boolean") {
          throw new CodecError("Tool result block 'is_error' must be boolean if present");
        }
        isError = b.is_error;
      }
      return {
        type: "tool_result",
        toolUseId: b.tool_use_id,
        content: b.content,
        isError,
      } as ToolResultBlock;
    }
    default:
      throw new CodecError(`Unknown block type: ${type}`);
  }
}

function convertDomainBlockToLegacy(block: DomainBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mediaType,
          data: block.base64Data,
        },
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result": {
      const result: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
      };
      // Omit is_error if false (the default)
      if (block.isError) {
        result.is_error = true;
      }
      return result;
    }
    default: {
      const _exhaustive: never = block;
      throw new CodecError(`Unknown block type: ${_exhaustive}`);
    }
  }
}

function isPlainObject(val: unknown): boolean {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}
