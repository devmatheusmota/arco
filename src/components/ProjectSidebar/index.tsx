/*
 * The project sidebar.
 *
 * There used to be two of these — one per `visualStyle`, each with its own
 * component tree and its own stylesheet, both drawing the same tree of projects
 * and sessions. Every visual fix had to be made twice, and so it usually was
 * not. `visualStyle` is a density preference now, not a second implementation.
 */
export { NormalProjectSidebar as ProjectSidebar } from './NormalProjectSidebar'
