import { Component, OnInit, Input, Inject, LOCALE_ID, ChangeDetectionStrategy, OnChanges } from '@angular/core';
import { formatDate } from '@angular/common';
import { VbytesPipe } from 'src/app/shared/pipes/bytes-pipe/vbytes.pipe';
import { formatNumber } from "@angular/common";

import { OptimizedMempoolStats } from 'src/app/interfaces/node-api.interface';
import { StateService } from 'src/app/services/state.service';
import { StorageService } from 'src/app/services/storage.service';
import { EChartsOption } from '@mempool/echarts';
import { feeLevels, chartColors } from 'src/app/app.constants';

@Component({
  selector: 'app-mempool-graph',
  templateUrl: './mempool-graph.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MempoolGraphComponent implements OnInit, OnChanges {
  @Input() data: any[];
  @Input() limitFee = 350;
  @Input() limitFilterFee = 1;
  @Input() height: number | string = 200;
  @Input() top: number | string = 20;
  @Input() right: number | string = 10;
  @Input() left: number | string = 75;
  @Input() template: ('widget' | 'advanced' | 'tv') = 'widget';
  @Input() showZoom = true;

  mempoolVsizeFeesData: any;
  mempoolVsizeFeesOptions: EChartsOption;
  mempoolVsizeFeesInitOptions = {
    renderer: 'svg',
  };
  windowPreference: string;
  hoverIndexSerie = 0;
  feeLimitIndex: number;
  feeLevelsOrdered = [];
  chartColorsOrdered = chartColors;
  inverted: boolean;

  constructor(
    private vbytesPipe: VbytesPipe,
    private stateService: StateService,
    private storageService: StorageService,
    @Inject(LOCALE_ID) private locale: string,
  ) { }

  ngOnInit(): void {
    this.inverted = this.storageService.getValue('inverted-graph') === 'true';
    this.mountFeeChart();
  }

  ngOnChanges() {
    this.windowPreference = this.storageService.getValue('graphWindowPreference');
    this.mempoolVsizeFeesData = this.handleNewMempoolData(this.data.concat([]));
    this.mountFeeChart();
  }

  onChartReady(myChart: any) {
    myChart.getZr().on('mousemove', (e: any) => {
      if (e.target !== undefined &&
        e.target.parent !== undefined &&
        e.target.parent.parent !== null &&
        e.target.parent.parent.__ecComponentInfo !== undefined) {
          this.hoverIndexSerie = e.target.parent.parent.__ecComponentInfo.index;
      }
    });
  }

  handleNewMempoolData(mempoolStats: OptimizedMempoolStats[]) {
    mempoolStats.reverse();
    const labels = mempoolStats.map(stats => stats.added);
    const finalArrayVByte = this.generateArray(mempoolStats);

    // Only Liquid has lower than 1 sat/vb transactions
    if (this.stateService.network !== 'liquid') {
      finalArrayVByte.shift();
    }

    return {
      labels: labels,
      series: finalArrayVByte
    };
  }

  generateArray(mempoolStats: OptimizedMempoolStats[]) {
    const finalArray: number[][] = [];
    let feesArray: number[] = [];
    let limitFeesTemplate = this.template === 'advanced' ? 28 : 21;
    if (this.stateService.network === 'liquid') {
      limitFeesTemplate = this.template === 'advanced' ? 26 : 20;
    }
    for (let index = limitFeesTemplate; index > -1; index--) {
      feesArray = [];
      mempoolStats.forEach((stats) => {
        feesArray.push(stats.vsizes[index] ? stats.vsizes[index] : 0);
      });
      finalArray.push(feesArray);
    }
    finalArray.reverse();
    return finalArray;
  }

  mountFeeChart() {
    this.orderLevels();
    const { labels, series } = this.mempoolVsizeFeesData;

    const seriesGraph = [];
    const newColors = [];
    for (let index = 0; index < series.length; index++) {
      const value = series[index];
      if (index >= this.feeLimitIndex) {
        newColors.push(this.chartColorsOrdered[index]);
        seriesGraph.push({
          name: this.feeLevelsOrdered[index],
          type: 'line',
          stack: 'fees',
          smooth: false,
          markPoint: {
            symbol: 'rect',
          },
          lineStyle: {
            width: 0,
            opacity: 0,
          },
          symbol: 'none',
          emphasis: {
            focus: 'none',
            areaStyle: {
              opacity: 0.85,
            },
          },
          markLine: {
            silent: true,
            symbol: 'none',
            lineStyle: {
              color: '#fff',
              opacity: 1,
              width: this.inverted ? 2 : 0,
            },
            data: [{
              yAxis: '1000000',
              label: {
                show: false,
                color: '#ffffff',
              }
            }],
          },
          areaStyle: {
            color: this.chartColorsOrdered[index],
            opacity: 1,
          },
          data: value
        });
      }
    }

    this.mempoolVsizeFeesOptions = {
      series: this.inverted ? [...seriesGraph].reverse() : seriesGraph,
      hover: true,
      color: this.inverted ? [...newColors].reverse() : newColors,
      tooltip: {
        show: (window.innerWidth >= 768) ? true : false,
        trigger: 'axis',
        alwaysShowContent: false,
        position: (pos, params, el, elRect, size) => {
          const positions = { top: (this.template !== 'widget') ? 0 : -30 };
          positions[['left', 'right'][+(pos[0] < size.viewSize[0] / 2)]] = 60;
          return positions;
        },
        extraCssText: `width: ${(this.template !== 'widget') ? '275px' : '200px'};
                      background: transparent;
                      border: none;
                      box-shadow: none;`,
        axisPointer: {
          type: 'line',
        },
        formatter: (params: any) => {
          const { totalValue, totalValueArray } = this.getTotalValues(params);
          const itemFormatted = [];
          let totalParcial = 0;
          let progressPercentageText = '';
          const items = this.inverted ? [...params].reverse() : params;
          items.map((item: any, index: number) => {
            totalParcial += item.value;
            const progressPercentage = (item.value / totalValue) * 100;
            const progressPercentageSum = (totalValueArray[index] / totalValue) * 100;
            let activeItemClass = '';
            let hoverActive = 0;
            if (this.inverted) {
              hoverActive = Math.abs(this.feeLevelsOrdered.length - item.seriesIndex - this.feeLevelsOrdered.length);
            } else {
              hoverActive = item.seriesIndex;
            }
            if (this.hoverIndexSerie === hoverActive) {
              progressPercentageText = `<div class="total-parcial-active">
                <span class="progress-percentage">
                  ${formatNumber(progressPercentage, this.locale, '1.2-2')}
                  <span class="symbol">%</span>
                </span>
                <span class="total-parcial-vbytes">
                  ${this.vbytesPipe.transform(totalParcial, 2, 'vB', 'MvB', false)}
                </span>
                <div class="total-percentage-bar">
                  <span class="total-percentage-bar-background">
                    <span style="
                      width: ${progressPercentage}%;
                      background: ${item.color}
                    "></span>
                  </span>
                </div>
              </div>`;
              activeItemClass = 'active';
            }
            itemFormatted.push(`<tr class="item ${activeItemClass}">
              <td class="indicator-container">
                <span class="indicator" style="
                  background-color: ${item.color}
                "></span>
                <span>
                  ${item.seriesName}
                </span>
              </td>
              <td class="total-progress-sum">
                <span>
                  ${this.vbytesPipe.transform(item.value, 2, 'vB', 'MvB', false)}
                </span>
              </td>
              <td class="total-progress-sum">
                <span>
                  ${this.vbytesPipe.transform(totalValueArray[index], 2, 'vB', 'MvB', false)}
                </span>
              </td>
              <td class="total-progress-sum-bar">
                <span class="total-percentage-bar-background">
                  <span style="
                    width: ${progressPercentageSum.toFixed(2)}%;
                    background-color: ${this.chartColorsOrdered[3]}
                  "></span>
                </span>
              </td>
            </tr>`);
          });
          const classActive = (this.template === 'advanced') ? 'fees-wrapper-tooltip-chart-advanced' : '';
          const titleRange = $localize`Range`;
          const titleSize = $localize`:@@7faaaa08f56427999f3be41df1093ce4089bbd75:Size`;
          const titleSum = $localize`Sum`;

          const date = new Date (params[0].axisValue);
          return `<div class="fees-wrapper-tooltip-chart ${classActive}">
            <div class="title">
              ${date.toLocaleDateString(this.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' })}
              <span class="total-value">
                ${this.vbytesPipe.transform(totalValue, 2, 'vB', 'MvB', false)}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>${titleRange}</th>
                  <th>${titleSize}</th>
                  <th>${titleSum}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${this.inverted ? itemFormatted.join('') : itemFormatted.reverse().join('')}
              </tbody>
            </table>
            <span class="total-value">
              ${progressPercentageText}
            </span>
          </div>`;
        }
      },
      dataZoom: [{
        type: 'inside',
        realtime: true,
        zoomOnMouseWheel: (this.template === 'advanced') ? true : false,
        maxSpan: (window.innerWidth >= 850 || this.template === 'widget') ? 100 : 40,
        minSpan: 10,
      }, {
        show: (this.template === 'advanced' && this.showZoom) ? true : false,
        type: 'slider',
        brushSelect: false,
        realtime: true,
        bottom: 0,
        labelFormatter: (value, valueStr) => {
          const date = new Date (valueStr);
          switch (this.windowPreference) {
            case '1w':
            case '1m':
              return date.toLocaleDateString(this.locale, { month: 'short', weekday: 'short', day: 'numeric' });
            case '3m':
            case '6m':
            case '1y':
              return date.toLocaleDateString(this.locale, { year: 'numeric', month: 'short' });
            default: // 2m, 24h
              return date.toLocaleTimeString(this.locale, { hour: 'numeric', minute: 'numeric' });
          }
        },
        selectedDataBackground: {
          lineStyle: {
            color: '#fff',
            opacity: 0.45,
          },
          areaStyle: {
            opacity: 0,
          }
        }
      }],
      animation: false,
      grid: {
        height: this.height,
        right: this.right,
        top: this.top,
        left: this.left,
      },
      xAxis: [
        {
          type: 'category',
          boundaryGap: false,
          axisLine: { onZero: true },
          axisTick: {
            alignWithLabel: true,
            lineStyle: {
              width: 1,
            },
            length: 8
          },
          axisLabel: {
            interval: this.getAxisLabelInterval(),
            align: 'center',
            fontSize: 11,
            lineHeight: 25,
            formatter: (value: string, index: number) => {
              const date = new Date(value);
              if (this.template !== 'advanced') {
                const dayControl = date.getDay();
                if (index === 0) {
                  return date.toLocaleTimeString(this.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                } else {
                  if (dayControl < date.getDay()) {
                    return date.toLocaleTimeString(this.locale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                  } else {
                    return date.toLocaleTimeString(this.locale, { hour: 'numeric', minute: 'numeric' });
                  }
                }
              }
              switch (this.windowPreference) {
                case '1w':
                case '1m':
                  return date.toLocaleDateString(this.locale, { month: 'short', weekday: 'short', day: 'numeric' });
                case '3m':
                case '6m':
                case '1y':
                  return date.toLocaleDateString(this.locale, { year: 'numeric', month: 'short' });
                default: // 2m, 24h
                  const dayControl = date.getDay();
                  if (index === 0) {
                    return date.toLocaleTimeString(this.locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                  } else {
                    if (dayControl < date.getDay()) {
                      return date.toLocaleTimeString(this.locale, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
                    } else {
                      return date.toLocaleTimeString(this.locale, { hour: 'numeric', minute: 'numeric' });
                    }
                  }
              }
            }
          },
          data: labels,
        }
      ],
      yAxis: {
        type: 'value',
        axisLine: { onZero: false },
        axisLabel: {
          fontSize: 11,
          formatter: (value: number) => (`${this.vbytesPipe.transform(value, 2, 'vB', 'MvB', true)}`),
        },
        splitLine: {
          lineStyle: {
            type: 'dotted',
            color: '#ffffff66',
            opacity: 0.25,
          }
        }
      },
    };
  }

  getTotalValues = (values: any) => {
    let totalValueTemp = 0;
    const totalValueArray = [];
    const valuesInverted = this.inverted ? values : [...values].reverse();
    for (const item of valuesInverted) {
      totalValueTemp += item.value;
      totalValueArray.push(totalValueTemp);
    }
    return {
      totalValue: totalValueTemp,
      totalValueArray: totalValueArray.reverse(),
    };
  }

  orderLevels() {
    this.feeLevelsOrdered = [];
    for (let i = 0; i < feeLevels.length; i++) {
      if (feeLevels[i] === this.limitFilterFee) {
        this.feeLimitIndex = i;
      }
      if (feeLevels[i] <= this.limitFee) {
        if (i === 0) {
          if (this.stateService.network === 'liquid') {
            this.feeLevelsOrdered.push('0 - 0.1');
          } else {
            this.feeLevelsOrdered.push('0 - 1');
          }
        } else {
          if (this.stateService.network === 'liquid') {
            this.feeLevelsOrdered.push(`${feeLevels[i - 1] / 10} - ${feeLevels[i] / 10}`);
          } else {
            this.feeLevelsOrdered.push(`${feeLevels[i - 1]} - ${feeLevels[i]}`);
          }
        }
      }
    }
    this.chartColorsOrdered =  chartColors.slice(0, this.feeLevelsOrdered.length);
  }
  getAxisLabelInterval() {
    if (this.template !== 'advanced') {
      return 30;
    }
    switch (this.windowPreference) {
      case '2h':
        return 14;
      case '24h':
        return 40;
      case '1w':
        return 68;
      case '1m':
        return 118;
      case '3m':
        return 140;
      case '6m':
        return 70;
      case '1y':
        return 40;
      default:
        return 5;
    }
  }
}
