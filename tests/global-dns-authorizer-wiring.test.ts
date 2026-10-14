import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/*
 * Source guard for `hack global dns activate|deactivate`. The handlers need a
 * real macOS host, Homebrew dnsmasq and sudo, so no test runs them. This guard
 * checks on the TypeScript syntax tree of src/commands/global.ts that each
 * handler installs createNativeDnsAuthorizer with its own action, and that the
 * flow it runs receives exactly that authorizer. The authorizer and the flows
 * are proven behaviorally in tests/native-domain-dns-authorization.test.ts.
 *
 * Limits: this is a syntax check of one file, not data flow. It trusts the
 * imported createNativeDnsAuthorizer and the flow functions by name.
 */

const GLOBAL_SOURCE = join(
  import.meta.dir,
  "..",
  "src",
  "commands",
  "global.ts"
);

const HANDLERS = [
  {
    handler: "handleGlobalDnsActivate",
    action: "activate",
    flow: "activateNativeDomainDns",
  },
  {
    handler: "handleGlobalDnsDeactivate",
    action: "deactivate",
    flow: "deactivateNativeDomainDns",
  },
] as const;

function parseGlobalSource(): ts.SourceFile {
  return ts.createSourceFile(
    GLOBAL_SOURCE,
    readFileSync(GLOBAL_SOURCE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function findFunction(
  source: ts.SourceFile,
  name: string
): ts.FunctionDeclaration {
  const found = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
  if (!found?.body) {
    throw new Error(`${name} not found in src/commands/global.ts`);
  }
  return found;
}

function collect<T extends ts.Node>(
  root: ts.Node,
  match: (node: ts.Node) => node is T
): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (match(node)) {
      out.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

function callsNamed(root: ts.Node, name: string): ts.CallExpression[] {
  return collect(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
  );
}

function objectArgument(call: ts.CallExpression): ts.ObjectLiteralExpression {
  const [arg] = call.arguments;
  if (!(arg && ts.isObjectLiteralExpression(arg))) {
    throw new Error("expected an object literal argument");
  }
  return arg;
}

/** The value of `name` in an object literal; shorthand yields the identifier. */
function propertyValue(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === name) {
        return property.name;
      }
    } else if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer;
    }
  }
  return;
}

/** The `const <name> = <initializer>` binding a call result is stored in. */
function constBindingName(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    ts.isIdentifier(parent.name) &&
    ts.isVariableDeclarationList(parent.parent) &&
    (parent.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    return parent.name.text;
  }
  return;
}

function isIdentifierNamed(
  node: ts.Node | undefined,
  name: string | undefined
): boolean {
  return (
    node !== undefined &&
    name !== undefined &&
    ts.isIdentifier(node) &&
    node.text === name
  );
}

/** `async () => false`: the only other authorizer a handler may pass. */
function isDecliningAuthorizer(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    ts.isArrowFunction(node) &&
    node.parameters.length === 0 &&
    node.body.kind === ts.SyntaxKind.FalseKeyword
  );
}

interface WiringReport {
  readonly authorizerActions: readonly string[];
  readonly authorizerDomains: readonly string[];
  readonly authorizerBinding: string | undefined;
  readonly flowCalls: number;
  readonly flowUsesAuthorizer: boolean;
  readonly otherAuthorizers: readonly string[];
}

function inspectHandler(
  source: ts.SourceFile,
  spec: (typeof HANDLERS)[number]
): WiringReport {
  const body = findFunction(source, spec.handler).body as ts.Block;
  const factoryCalls = callsNamed(body, "createNativeDnsAuthorizer");
  const authorizerActions = factoryCalls.map((call) => {
    const action = propertyValue(objectArgument(call), "action");
    return action && ts.isStringLiteral(action) ? action.text : "<dynamic>";
  });
  const authorizerDomains = factoryCalls.map((call) => {
    const domain = propertyValue(objectArgument(call), "domain");
    return domain?.getText(source) ?? "<missing>";
  });
  const [factoryCall] = factoryCalls;
  const authorizerBinding =
    factoryCalls.length === 1 && factoryCall
      ? constBindingName(factoryCall)
      : undefined;

  const hostCalls = callsNamed(body, "createNativeDnsHostDependencies");
  const otherAuthorizers: string[] = [];
  const hostBindingsWithAuthorizer = new Set<string>();
  for (const call of hostCalls) {
    const authorize = propertyValue(objectArgument(call), "authorize");
    if (isIdentifierNamed(authorize, authorizerBinding)) {
      const binding = constBindingName(call);
      if (binding) {
        hostBindingsWithAuthorizer.add(binding);
      }
    } else if (!isDecliningAuthorizer(authorize)) {
      otherAuthorizers.push(authorize?.getText(source) ?? "<missing>");
    }
  }

  const flowCalls = callsNamed(body, spec.flow);
  const flowUsesAuthorizer =
    flowCalls.length > 0 &&
    flowCalls.every((call) => {
      const deps = propertyValue(objectArgument(call), "dependencies");
      return (
        deps !== undefined &&
        ts.isIdentifier(deps) &&
        hostBindingsWithAuthorizer.has(deps.text)
      );
    });

  return {
    authorizerActions,
    authorizerDomains,
    authorizerBinding,
    flowCalls: flowCalls.length,
    flowUsesAuthorizer,
    otherAuthorizers,
  };
}

for (const spec of HANDLERS) {
  test(`${spec.handler} runs ${spec.flow} with the native ${spec.action} authorizer`, () => {
    const report = inspectHandler(parseGlobalSource(), spec);
    expect(report).toEqual({
      authorizerActions: [spec.action],
      authorizerDomains: ["domain"],
      authorizerBinding: expect.any(String),
      flowCalls: 1,
      flowUsesAuthorizer: true,
      otherAuthorizers: [],
    });
  });
}
