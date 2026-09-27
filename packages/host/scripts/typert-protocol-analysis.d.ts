/**
 * Ambient, build-time view used only by the current DSH Typert analyzer.
 *
 * The analyzer recognizes protocol declarations from workspace packages or
 * ambient modules. This declaration lets it see Remote metadata from the
 * installed protocol package while all runtime imports still resolve to the
 * official npm package.
 */
declare module "@deepseek-ai/dsh-typert-protocol" {
	import type { Context, Service } from "@deepseek-ai/cordis";
	const lookupHost: unique symbol;
	const lookupWire: unique symbol;
	const contextWire: unique symbol;
	export interface TypertLookup<Host, Wire> {
		readonly [lookupHost]: Host;
		readonly [lookupWire]: Wire;
	}
	export interface TypertContext<Wire> {
		readonly [contextWire]: Wire;
	}
	export interface TypertLookupMap {}
	export interface TypertContextMap {}
	export interface TypertRemoteMap {}
	export interface TypertRemoteScopeMap {}

	export interface TypertGatewayBindingOptions {
		namespace?: string;
	}

	export abstract class TypertRemoteService<T = never> extends Service<T> {
		protected constructor(
			ctx: Context,
			serviceKey: string,
			options?: TypertGatewayBindingOptions,
		);
	}

	export function Remote<This extends object, Args extends unknown[], Result>(
		_method: (this: This, ...args: Args) => Result,
		context: ClassMethodDecoratorContext<
			This,
			(this: This, ...args: Args) => Result
		>,
	): void;
}
