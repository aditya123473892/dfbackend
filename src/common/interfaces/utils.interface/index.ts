import { SortOrder } from 'mongoose';

export interface IFindParams {
  populates?: any[];
  sortBy?: string;
  order?: SortOrder;
  limit?: number;
  skip?: number;
  _id?: string;
  user?: string;
}

export const DefaultFindParams: IFindParams = {
  sortBy: '_id',
  order: -1,
  limit: 20,
  skip: 0,
};

export interface IFindOneItem {
  _id?: string;
  payload?: any;
}
