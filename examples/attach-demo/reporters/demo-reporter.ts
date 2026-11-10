/**
 * A relative custom reporter, preserved and path-rebased by the attach wrapper.
 * It prints one line so the demo can prove base reporters still run.
 */
export default class DemoReporter {
  onBegin(_config: unknown, suite: { allTests(): unknown[] }): void {
    console.log('demo-reporter: collected ' + suite.allTests().length + ' test(s)');
  }
  onEnd(result: { status: string }): void {
    console.log('demo-reporter: run finished with status ' + result.status);
  }
}
