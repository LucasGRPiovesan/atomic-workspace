import { repo } from '../db/memory.ts';

export const catalogService = {
  async getAllProducts() {
    return repo.products.findAll();
  },

  async getProductById(id: string) {
    return repo.products.findById(id);
  },
};