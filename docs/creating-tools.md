# Creating New Tools Guide

This guide explains how to create new tools that integrate seamlessly with the existing codebase while following established patterns and best practices.

## Tool Structure Overview

Every tool follows a consistent structure:

1. Input validation using Zod schemas
2. Core functionality implementation
3. Tool factory function that creates the tool interface
4. Standardized error handling and responses

## Step-by-Step Implementation Guide

### 1. Create the Tool Directory

Create a new directory under `src/tools/` with your tool name:

```bash
src/tools/your-tool-name/
└── index.ts
```

### 2. Define the Input Schema

Start by defining a Zod schema for input validation. Always include descriptions for better documentation:

```typescript
const schema = z.object({
  param1: z.string()
    .min(1, "Parameter cannot be empty")
    .describe("Description of what this parameter does"),
  param2: z.number()
    .min(0)
    .describe("Description of numeric constraints"),
  optionalParam: z.string()
    .optional()
    .describe("Optional parameters should have clear descriptions too")
}).strict();

const schemaHandler = createSchemaHandler(schema);
```

### 3. Implement Core Functionality

Create a private async function that implements the tool's core logic:

```typescript
async function performOperation(
  vaultPath: string,
  param1: string,
  param2: number,
  optionalParam?: string
): Promise<OperationResult> {
  try {
    // Implement core functionality
    // Use utility functions for common operations
    // Handle errors appropriately
    return {
      success: true,
      message: "Operation completed successfully",
      // Include relevant details
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'operation name');
  }
}
```

### 4. Create the Tool Factory

Export a factory function that creates the tool interface:

```typescript
export function createYourTool(vaultPath: string): Tool {
  if (!vaultPath) {
    throw new Error("Vault path is required");
  }

  return {
    name: "your-tool-name",
    description: `Clear description of what the tool does.

Examples:
- Basic usage: { "param1": "value", "param2": 42 }
- With options: { "param1": "value", "param2": 42, "optionalParam": "extra" }`,
    inputSchema: schemaHandler,
    handler: async (args) => {
      try {
        const validated = schemaHandler.parse(args);
        const result = await performOperation(
          vaultPath,
          validated.param1,
          validated.param2,
          validated.optionalParam
        );
        
        return createToolResponse(formatOperationResult(result));
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
          );
        }
        throw error;
      }
    }
  };
}
```

## Best Practices

### Input Validation

✅ DO:

- Use strict schemas with `.strict()`
- Provide clear error messages for validation
- Include descriptions for all parameters
- Validate paths are within vault when relevant
- Use discriminated unions for operations with different requirements
- Keep validation logic JSON Schema-friendly

#### Handling Conditional Validation

When dealing with operations that have different validation requirements, prefer using discriminated unions over complex refinements:

```typescript
// ✅ DO: Use discriminated unions for different operation types
const deleteSchema = z.object({
  operation: z.literal('delete'),
  target: z.string(),
  content: z.undefined()
}).strict();

const editSchema = z.object({
  operation: z.enum(['update', 'append']),
  target: z.string(),
  content: z.string().min(1)
}).strict();

const schema = z.discriminatedUnion('operation', [
  deleteSchema,
  editSchema
]);

// ❌ DON'T: Use complex refinements that don't translate well to JSON Schema
const schema = z.object({
  operation: z.enum(['delete', 'update', 'append']),
  target: z.string(),
  content: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.operation === 'delete') {
    if (data.content !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Content not allowed for delete"
      });
    }
  } else if (!data.content) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Content required for non-delete"
    });
  }
});
```

#### Schema Design Patterns

When designing schemas:

✅ DO:

- Break down complex schemas into smaller, focused schemas
- Use discriminated unions for operations with different requirements
- Keep validation logic simple and explicit
- Consider how schemas will translate to JSON Schema
- Use literal types for precise operation matching

❌ DON'T:

```typescript
// Don't use complex refinements that access parent data
schema.superRefine((val, ctx) => {
  const parent = ctx.parent; // Unreliable
});

// Don't mix validation concerns
const schema = z.object({
  operation: z.enum(['delete', 'update']),
  content: z.string().superRefine((val, ctx) => {
    // Don't put operation-specific logic here
  })
});

// Don't skip schema validation
const schema = z.object({
  path: z.string() // Missing validation and description
});

// Don't allow unsafe paths
const schema = z.object({
  path: z.string().describe("File path")  // Missing path validation
});
```

### Error Handling

✅ DO:

- Use utility functions for common errors
- Convert filesystem errors to McpErrors
- Provide specific error messages

❌ DON'T:

```typescript
// Don't throw raw errors
catch (error) {
  throw error;
}

// Don't ignore validation errors
handler: async (args) => {
  const result = await performOperation(args.param); // Missing validation
}
```

### Response Formatting

✅ DO:

- Use response utility functions
- Return standardized result objects
- Include relevant operation details

❌ DON'T:

```typescript
// Don't return raw strings
return createToolResponse("Done"); // Too vague

// Don't skip using proper response types
return {
  message: "Success" // Missing proper response structure
};
```

### Code Organization

✅ DO:

- Split complex logic into smaller functions
- Use utility functions for common operations
- Keep the tool factory function clean

❌ DON'T:

```typescript
// Don't mix concerns in the handler
handler: async (args) => {
  // Don't put core logic here
  const files = await fs.readdir(path);
  // ... more direct implementation
}

// Don't duplicate utility functions
function isValidPath(path: string) {
  // Don't reimplement existing utilities
}
```

## Schema Conversion Considerations

When creating schemas, remember they need to be converted to JSON Schema for the MCP interface:

### JSON Schema Compatibility

✅ DO:

- Test your schemas with the `createSchemaHandler` utility
- Use standard Zod types that have clear JSON Schema equivalents
- Structure complex validation using composition of simple schemas
- Verify generated JSON Schema matches expected validation rules

❌ DON'T:

- Rely heavily on refinements that don't translate to JSON Schema
- Use complex validation logic that can't be represented in JSON Schema
- Access parent context in nested validations
- Assume all Zod features will work in JSON Schema

### Schema Handler Usage

```typescript
// ✅ DO: Test schema conversion
const schema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('read'),
    path: z.string()
  }),
  z.object({
    operation: z.literal('write'),
    path: z.string(),
    content: z.string()
  })
]);

// Verify schema handler creation succeeds
const schemaHandler = createSchemaHandler(schema);

// ❌ DON'T: Use features that don't convert well
const schema = z.object({
  data: z.any().superRefine((val, ctx) => {
    // Complex custom validation that won't translate
  })
});
```

## Common Utilities

Make use of existing utilities:

- `createSchemaHandler`: For input validation
- `handleFsError`: For filesystem error handling
- `createToolResponse`: For formatting responses
- `validateVaultPath`: For path validation
- `ensureDirectory`: For directory operations
- `formatOperationResult`: For standardized results

## Testing Your Tool

1. Ensure your tool handles edge cases:
   - Invalid inputs
   - File/directory permissions
   - Non-existent paths
   - Concurrent operations

2. Verify error messages are helpful:
   - Validation errors should guide the user
   - Operation errors should be specific
   - Path-related errors should be clear

3. Check response formatting:
   - Success messages should be informative
   - Error messages should be actionable
   - Operation details should be complete

## Integration

After implementing your tool:

1. Export it from `src/tools/index.ts`
2. Register it in `src/server.ts`
3. Update any relevant documentation
4. Add appropriate error handling utilities if needed

Remember: Tools should be focused, well-documented, and follow the established patterns in the codebase. When in doubt, look at existing tools like `create-note` or `edit-note` as references.
