declare module "cdt2d" {
  function cdt2d(
    points: [number, number][],
    edges: [number, number][],
    options?: { exterior?: boolean; interior?: boolean },
  ): [number, number, number][]
  export = cdt2d
}
