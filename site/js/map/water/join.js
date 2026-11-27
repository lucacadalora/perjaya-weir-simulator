// Where the river sheets hand over to the water inside the weir. Owner: lane b06; lane b08's weir water imports it.
// Distances in metres from the weir axis, measured along the river. The river sheets stop exactly on these lines;
// the weir's own water runs `feather` metres past them, fading out, so no edge shows where the two meet. Both lie
// at the same level there (the sheets are flat for their first `flat` metres). Display choices, not researched
// numbers: upstream the line clears the pier noses, downstream it clears the longest stilling basin and its sill.
export const JOIN = Object.freeze({ up: 12, down: 60, feather: 5, flat: 160 });
