// d3-flextree ships no TypeScript types. Minimal ambient declaration
// covering the subset of the API this plugin uses. Verified empirically
// against the installed version (2.x) — see DECISIONS.md.
declare module "d3-flextree" {
	export interface FlextreeNode<Datum> {
		data: Datum;
		x: number;
		y: number;
		depth: number;
		children: Array<FlextreeNode<Datum>> | null;
		parent: FlextreeNode<Datum> | null;
		each(fn: (node: FlextreeNode<Datum>) => void): this;
	}

	export interface FlextreeLayout<Datum> {
		(root: FlextreeNode<Datum>): FlextreeNode<Datum>;
		hierarchy(data: Datum, children?: (d: Datum) => Datum[] | null | undefined): FlextreeNode<Datum>;
		nodeSize(fn: (node: FlextreeNode<Datum>) => [number, number]): FlextreeLayout<Datum>;
		spacing(fn: (a: FlextreeNode<Datum>, b: FlextreeNode<Datum>) => number): FlextreeLayout<Datum>;
	}

	export function flextree<Datum>(options?: {
		children?: (d: Datum) => Datum[] | null | undefined;
		nodeSize?: (node: FlextreeNode<Datum>) => [number, number];
		spacing?: number | ((a: FlextreeNode<Datum>, b: FlextreeNode<Datum>) => number);
	}): FlextreeLayout<Datum>;
}
